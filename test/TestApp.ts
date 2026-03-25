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
    IPostLivechatRoomTransferred,
    ILivechatTransferEventContext,
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
 * Aplicativo principal para gestão proativa de fila no Omnichannel.
 * Alinhado com o BbtsTransferRoomApp para notificar posições em transferências.
 */
export class TesteApp
    extends App
    implements
        IPostMessageSent,
        IPostLivechatAgentAssigned,
        IPostLivechatRoomClosed,
        IPostLivechatRoomTransferred
{
    constructor(info: IAppInfo, logger: ILogger, accessors: IAppAccessors) {
        super(info, logger, accessors);
    }

    private getPersistenceService(
        read: IRead,
        persistence: IPersistence,
    ): PersistenceService {
        return new PersistenceService(persistence, read.getPersistenceReader());
    }

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

    protected async extendConfiguration(
        configuration: IConfigurationExtend,
    ): Promise<void> {
        await registerSettings(configuration);
    }

    /**
     * Lógica centralizada para cálculo de fila e envio de mensagem ao visitante.
     */
    private async notifyQueueStatus(
        room: ILivechatRoom,
        departmentId: string,
        read: IRead,
        modify: IModify,
        persistenceService: PersistenceService,
        service: LivechatService,
    ): Promise<void> {
        const credentials = await getCredentials(read);
        if (!credentials) return;

        // Verifica se o visitante já foi notificado nesta instância de fila
        if (await persistenceService.isRoomNotified(room.id)) return;

        const position = await service.getQueuePosition(departmentId, room.id);
        if (position === null || position < credentials.min_queue_size) return;

        const avgSeconds = await service.getAvgWaitingTime(departmentId);
        const estimatedMinutes = avgSeconds
            ? secondsToMinutes(avgSeconds) * position
            : 0;

        // Registra estado para evitar reenvio e permitir acompanhamento de progresso
        await persistenceService.markAsNotified(room.id);
        await persistenceService.updateRoomPosition(room.id, position);

        const msg = `Olá! Você entrou na fila de atendimento na posição ${position}º. Tempo estimado: ~${estimatedMinutes} minuto(s).`;
        await service.sendMessageToVisitor(room, msg, read, modify);

        this.getLogger().info(
            `Notificação enviada: Sala ${room.id} | Pos: ${position} | Dept: ${departmentId}`,
        );
    }

    /**
     * Trigger para mensagens enviadas (Entrada inicial na fila).
     */
    public async executePostMessageSent(
        message: IMessage,
        read: IRead,
        http: IHttp,
        persistence: IPersistence,
        modify: IModify,
    ): Promise<void> {
        const appUser = await read.getUserReader().getAppUser();
        if (
            (appUser && message.sender.id === appUser.id) ||
            message.type ||
            message.room.type !== "l"
        ) {
            return;
        }

        const room = (await read
            .getRoomReader()
            .getById(message.room.id)) as ILivechatRoom;
        if (!room || room.servedBy || !room.department) return;

        const persistenceService = this.getPersistenceService(
            read,
            persistence,
        );
        const service = await this.getLivechatService(read, http);
        if (!service) return;

        await this.notifyQueueStatus(
            room,
            room.department.id,
            read,
            modify,
            persistenceService,
            service,
        );
    }

    /**
     * Trigger para transferências (Alinhamento com App de Transferência).
     */
    public async executePostLivechatRoomTransferred(
        context: ILivechatTransferEventContext,
        read: IRead,
        http: IHttp,
        persistence: IPersistence,
        modify: IModify,
    ): Promise<void> {
        const service = await this.getLivechatService(read, http);
        if (!service) return;

        // Acessamos a sala do contexto para verificar o departamento atualizado
        const room = context.room as ILivechatRoom;
        let targetDepartmentId = room.department?.id;

        // Se a sala não tem departamento definido, mas foi transferida para um agente (nominal)
        if (!targetDepartmentId && room.servedBy) {
            // Buscamos o departamento vinculado ao agente que agora serve a sala
            targetDepartmentId =
                (await service.getAgentDepartmentId(room.servedBy._id)) ??
                undefined;
        }

        // Se mesmo assim não houver departamento, não há como calcular fila/tempo médio
        if (!targetDepartmentId) return;

        const persistenceService = this.getPersistenceService(
            read,
            persistence,
        );

        // Limpamos os dados antigos para que a nova notificação seja permitida
        await persistenceService.clearRoomData(room.id);

        await this.notifyQueueStatus(
            room,
            targetDepartmentId,
            read,
            modify,
            persistenceService,
            service,
        );
    }
    /**
     * Trigger para quando a fila anda (Agente atribuído).
     */
    public async executePostLivechatAgentAssigned(
        data: ILivechatEventContext,
        read: IRead,
        http: IHttp,
        persistence: IPersistence,
        modify: IModify,
    ): Promise<void> {
        const persistenceService = this.getPersistenceService(
            read,
            persistence,
        );
        const departmentId = data.room.department?.id;
        if (!departmentId) return;

        const service = await this.getLivechatService(read, http);
        if (!service) return;

        const queuedRooms = await service.getQueuedRooms(departmentId);
        if (queuedRooms.length === 0) return;

        const avgSeconds = await service.getAvgWaitingTime(departmentId);
        const avgMinutes = avgSeconds ? secondsToMinutes(avgSeconds) : 0;

        for (let i = 0; i < queuedRooms.length; i++) {
            const currentRoomId = queuedRooms[i]._id;
            const newPosition = i + 1;
            const lastPosition =
                (await persistenceService.getLastPosition(currentRoomId)) ?? 0;

            if (lastPosition === 0 || newPosition < lastPosition) {
                const estimatedMinutes = avgMinutes * newPosition;
                const msg = `A fila andou! Você agora é o ${newPosition}º. Tempo estimado restante: ~${estimatedMinutes} minuto(s).`;

                const fullRoomInfo = await read
                    .getRoomReader()
                    .getById(currentRoomId);
                if (fullRoomInfo) {
                    await service.sendMessageToVisitor(
                        fullRoomInfo as ILivechatRoom,
                        msg,
                        read,
                        modify,
                    );
                    await persistenceService.updateRoomPosition(
                        currentRoomId,
                        newPosition,
                    );
                }
            }
        }
    }

    /**
     * Limpeza de dados ao fechar a sala.
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
        await persistenceService.clearRoomData(context.id);
    }
}
