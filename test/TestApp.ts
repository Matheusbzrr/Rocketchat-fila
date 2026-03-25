import {
    IAppAccessors,
    IConfigurationExtend,
    IHttp,
    ILogger,
    IModify,
    IPersistence,
    IRead,
} from "@rocket.chat/apps-engine/definition/accessors";
import { App } from "@rocket.chat/apps-engine/definition/App";
import {
    ILivechatEventContext,
    ILivechatRoom,
    IPostLivechatAgentAssigned,
    IPostLivechatRoomClosed,
} from "@rocket.chat/apps-engine/definition/livechat";
import {
    IMessage,
    IPostMessageSent,
} from "@rocket.chat/apps-engine/definition/messages";
import { IAppInfo } from "@rocket.chat/apps-engine/definition/metadata";
import { getCredentials, registerSettings } from "./settings/registerSettings";
import { LivechatService } from "./services/LivechatService";
import { secondsToMinutes } from "./helpers/dateHelper";
import { PersistenceService } from "./services/QueuePersistenceService";

/**
 * aplicativo principal para gestão proativa de fila no Omnichannel.
 * intercepta mensagens e atribuições de agentes para manter o visitante
 * atualizado sobre sua posição e tempo estimado de espera
 */
export class TesteApp
    extends App
    implements
        IPostMessageSent,
        IPostLivechatAgentAssigned,
        IPostLivechatRoomClosed
{
    constructor(info: IAppInfo, logger: ILogger, accessors: IAppAccessors) {
        super(info, logger, accessors);
    }

    /**
     * instancia o serviço de persistência dedicado do App.
     * como os acessores de persistência são injetados pelo framework apenas durante a execução
     * de um evento, este método garante a criação do serviço com o contexto correto.
     * @param read acessor de leitura do workspace
     * @param persistence acessor de gravação de dados
     * @returns uma nova instancia de PersistenceService
     */
    private getPersistenceService(
        read: IRead,
        persistence: IPersistence,
    ): PersistenceService {
        return new PersistenceService(persistence, read.getPersistenceReader());
    }

    /**
     * fabrica e configura o serviço de integração com o Omnichannel.
     * realiza a busca assincrona das credenciais nas configurações do App e valida
     * a disponibilidade dos dados antes de instanciar o serviço.
     * @param read acessor de leitura para buscar as configurações
     * @param http acessor para realizar chamadas REST à API do Rocket.Chat
     * @returns instancia configurada do LivechatService ou null caso faltem credenciais
     */
    private async getLivechatService(
        read: IRead,
        http: IHttp,
    ): Promise<LivechatService | null> {
        const credentials = await getCredentials(read);
        if (!credentials) {
            this.getLogger().error(
                "Credenciais do Omnichannel não configuradas.",
            );
            return null;
        }

        return new LivechatService(http, {
            token: credentials.token,
            userId: credentials.userId,
            numberDays: credentials.number_days,
        });
    }

    /**
     * registra as configurações customizadas do App no painel administrativo do RocketChat.
     * @param configuration acessor para extensão da configuração do App
     */
    protected async extendConfiguration(
        configuration: IConfigurationExtend,
    ): Promise<void> {
        await registerSettings(configuration);
    }

    /**
     * trigger disparado sempre que uma mensagem é enviada em qualquer sala
     * utilizado aqui especificamente para detectar a primeira interação de um visitante
     * em uma sala de Livechat e notificá-lo sobre sua posição inicial na fila.
     * * @param message objeto contendo os dados da mensagem enviada
     * @param read acessor para leitura de dados do workspace (salas, usuarios, persistencia)
     * @param http acessor para chamadas HTTP externas/internas
     * @param persistence acessor para gravar dados no banco do RocketChat
     * @param modify acessor para criar ou modificar elementos no workspace (ex: enviar mensagens)
     */
    public async executePostMessageSent(
        message: IMessage,
        read: IRead,
        http: IHttp,
        persistence: IPersistence,
        modify: IModify,
    ): Promise<void> {
        const persistenceService = this.getPersistenceService(
            read,
            persistence,
        );

        const logger = this.getLogger();

        // travas de segurança para evitar loops infinitos e processamento desnecessário
        const appUser = await read.getUserReader().getAppUser();
        if (
            (appUser && message.sender.id === appUser.id) || // ignora mensagens do próprio bot
            message.type || // ignora mensagens de sistema (ex: "usuario entrou na sala")
            message.room.type !== "l" // ignora qualquer sala que não seja omnichannel (livechat)
        ) {
            return;
        }

        const room = (await read
            .getRoomReader()
            .getById(message.room.id)) as ILivechatRoom;

        // ignora se a sala já estiver em atendimento (não está mais na fila) ou sem departamento
        if (!room || room.servedBy) return;

        if (!room.department) {
            logger.warn(`Sala ${room.id} sem departamento ainda.`);
            return;
        }

        // prevenção de spam: verifica se o visitante já recebeu o aviso inicial
        if (await persistenceService.isQueueNotified(room.id)) return;

        // regras de Negócio e lógica de Fila
        const credentials = await getCredentials(read);
        if (!credentials) return;

        const service = await this.getLivechatService(read, http);
        if (!service) return;

        const position = await service.getQueuePosition(
            room.department.id,
            room.id,
        );

        if (position === null || position < credentials.min_queue_size) return;

        const avgSeconds = await service.getAvgWaitingTime(room.department.id);
        const estimatedMinutes = avgSeconds
            ? secondsToMinutes(avgSeconds) * position
            : 0;

        // registro de estado: marca a sala como notificada para evitar reenvios na mesma sessão
        await persistenceService.markQueueNotified(room.id);

        // registra a posição atual para servir de base de comparação nos eventos futuros de atualização
        await persistenceService.updateRoomPosition(room.id, position);

        // envia notificação
        const msg = `Olá! Você entrou na fila de atendimento na posição ${position}º. Tempo estimado: ~${estimatedMinutes} minuto(s).`;
        await service.sendMessageToVisitor(room, msg, read, modify);
        logger.info(
            `Entrada na fila notificada. Sala: ${room.id} | Posição: ${position}`,
        );
    }

    /**
     * gatilho disparado automaticamente quando um agente assume uma conversa da fila.
     * utilizado para recalcular a posição de todos os visitantes que continuam aguardando
     * no mesmo departamento e enviar uma atualização proativa.
     * * @param data contexto do evento de Livechat contendo a sala recém-atribuída
     * @param read acessor para leitura de dados
     * @param http acessor para chamadas HTTP
     * @param persistence acessor para gravar e atualizar o controle de posições
     * @param modify acessor para enviar as atualizações no chat
     */
    public async executePostLivechatAgentAssigned(
        data: ILivechatEventContext,
        read: IRead,
        http: IHttp,
        persistence: IPersistence,
        modify: IModify,
    ): Promise<void> {
        const logger = this.getLogger();

        const persistenceService = this.getPersistenceService(
            read,
            persistence,
        );

        // 🔹 Notificação de atribuição (transferência ou direto)
        const alreadyAssignedNotified =
            await persistenceService.isAssignedNotified(data.room.id);

        if (!alreadyAssignedNotified) {
            const service = await this.getLivechatService(read, http);
            if (!service) return;

            const departmentId = data.room.department?.id;

            let msg = `Olá! Seu atendimento foi direcionado para um agente.`;

            // 🔥 AQUI entra teu diferencial
            if (departmentId) {
                const avgSeconds =
                    await service.getAvgWaitingTime(departmentId);
                const avgMinutes = avgSeconds
                    ? secondsToMinutes(avgSeconds)
                    : null;

                if (avgMinutes) {
                    msg += ` Tempo médio de espera neste setor: ~${avgMinutes} minuto(s).`;
                }
            }

            await service.sendMessageToVisitor(data.room, msg, read, modify);

            await persistenceService.markAssignedNotified(data.room.id);

            logger.info(`Atribuição/transferência notificada: ${data.room.id}`);
        }

        logger.info(
            `Evento de Agente Atribuído iniciado para a sala: ${data.room.id}`,
        );

        const departmentId = data.room.department?.id;

        if (!departmentId) {
            logger.warn(
                `Sala ${data.room.id} não possui departamento. Cancelando atualização de fila.`,
            );
            return;
        }

        const credentials = await getCredentials(read);
        if (!credentials) {
            logger.error("Credenciais não configuradas.");
            return;
        }

        const service = await this.getLivechatService(read, http);
        if (!service) return;

        // identifica os visitantes restantes no departamento
        logger.info(`Buscando fila para o departamento: ${departmentId}`);
        const queuedRooms = await service.getQueuedRooms(departmentId);

        logger.info(
            `Salas restantes na fila do departamento: ${queuedRooms.length}`,
        );

        if (queuedRooms.length === 0) {
            logger.info("Ninguém mais na fila. Processo encerrado.");
            return; // Se não tem ninguém na fila, não há quem atualizar
        }

        const avgSeconds = await service.getAvgWaitingTime(departmentId);
        const avgMinutes = avgSeconds ? secondsToMinutes(avgSeconds) : 0;

        // varre a fila atualizando quem sobrou
        for (let i = 0; i < queuedRooms.length; i++) {
            const currentRoom = queuedRooms[i];
            const newPosition = i + 1; // fila real

            const lastPosition =
                (await persistenceService.getLastPosition(currentRoom._id)) ??
                0;

            logger.info(
                `Visitante ${currentRoom._id} - Posição antiga: ${lastPosition} | Nova: ${newPosition}`,
            );

            // avisa se ele avançou na fila
            if (lastPosition === 0 || newPosition < lastPosition) {
                const estimatedMinutes = avgMinutes * newPosition;
                const msg = `A fila andou! Você agora é o ${newPosition}º. Tempo estimado restante: ~${estimatedMinutes} minuto(s).`;

                const fullRoomInfo = await read
                    .getRoomReader()
                    .getById(currentRoom._id);
                if (fullRoomInfo) {
                    await service.sendMessageToVisitor(
                        fullRoomInfo as ILivechatRoom,
                        msg,
                        read,
                        modify,
                    );

                    // Atualização de posição na fila
                    await persistenceService.updateRoomPosition(
                        currentRoom._id,
                        newPosition,
                    );

                    logger.info(
                        `Mensagem de atualização enviada para ${currentRoom._id}`,
                    );
                }
            }
        }
    }

    /**
     * trigger disparado automaticamente quando uma sala de Livechat é encerrada.
     * utilizado para realizar a limpeza (housekeeping) dos dados persistidos do App,
     * removendo travas de notificação e históricos de posição para liberar espaço
     * e garantir que novos contatos do mesmo visitante iniciem com o estado limpo.
     * * @param context objeto contendo os dados da sala que foi fechada
     * @param read acessor para leitura de dados do workspace
     * @param http acessor para chamadas HTTP
     * @param persistence acessor para remover os dados vinculados à sala
     */
    public async executePostLivechatRoomClosed(
        context: ILivechatRoom,
        read: IRead,
        http: IHttp,
        persistence: IPersistence,
    ): Promise<void> {
        const persistenceService = this.getPersistenceService(
            read,
            persistence,
        );

        // remove todas as associações (fila-iniciada e last-position) vinculadas ao ID da sala
        await persistenceService.clearRoomData(context.id);

        this.getLogger().info(
            `Dados da sala ${context.id} limpos com sucesso após o encerramento do chat.`,
        );
    }
}
