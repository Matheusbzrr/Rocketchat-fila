import {
    IHttp,
    IModify,
    IRead,
} from "@rocket.chat/apps-engine/definition/accessors";
import { getDateRange } from "../helpers/dateHelper";
import { ILivechatServiceConfig } from "../interfaces/LivechatServiceConfig";
import { IAvgWaitingTimeResponse } from "../interfaces/IAvgWaitingTimeResponse";
import {
    ILivechatRoomItem,
    ILivechatRoomsResponse,
} from "../interfaces/ILivechatRoomsResponse";
import { ILivechatRoom } from "@rocket.chat/apps-engine/definition/livechat";

const ROCKET_URL = "http://localhost:3000";

/**
 * serviço de integração com a API REST do módulo Omnichannel (Livechat) do rocketchat.
 * sentraliza a comunicação http para consultas de fila, métricas e envio de mensagens
 */

export class LivechatService {
    constructor(
        /**
         * @param http acessor HTTP do Apps-Engine para requisições externas/internas
         * @param config configurações do serviço, contendo token: string; userId: string; numberDays?: number; timezone?: string; locale?: string;
         */
        private readonly http: IHttp,
        private readonly config: ILivechatServiceConfig,
    ) {}

    private get headers() {
        /**
         * retorna os cabeçalhos de autenticação necessarios para consumir a api.
         */
        return {
            "X-Auth-Token": this.config.token,
            "X-User-Id": this.config.userId,
            "Content-Type": "application/json",
        };
    }

    /**
     * busca a lista de salas que estão atualmente aguardando atendimento em um departamento.
     * a lista é ordenada cronologicamente (do tempo de espera mais antigo para o mais recente).
     * * @param departmentId ID do departamento Omnichannel alvo
     * @returns Array de salas na fila, omitindo as que já possuem um agente (`servedBy`)
     */
    public async getQueuedRooms(
        departmentId: string,
    ): Promise<ILivechatRoomItem[]> {
        // ordenação pela api: queuedAt = 1 garante a ordem do mais antigo para o mais novo
        const sortQuery = JSON.stringify({ queuedAt: 1 });
        const url = `${ROCKET_URL}/api/v1/livechat/rooms?queued=true&departmentId=${departmentId}&sort=${encodeURIComponent(sortQuery)}`;

        const response = await this.http.get(url, { headers: this.headers });
        const data = response.data as ILivechatRoomsResponse;

        if (!data?.rooms) return [];

        // filtra os que nao possuem atendente.
        return data.rooms.filter((r) => !r.servedBy);
    }

    /**
     * calcula a posição exata de um visitante na fila de espera do seu departamento.
     * * @param departmentId ID do departamento em que o usuario esta aguardando
     * @param roomId ID da sala de chat do usuário
     * @returns o número da posição na fila (1-based) ou `null` se a sala n estiver mais na fila
     */
    public async getQueuePosition(
        departmentId: string,
        roomId: string,
    ): Promise<number | null> {
        const queuedRooms = await this.getQueuedRooms(departmentId);

        // encontra o índice da sala atual na matriz de fila
        const index = queuedRooms.findIndex((r) => r._id === roomId);

        // se o index for -1, a sala não foi encontrada entre as pendentes (possivelmente já atendida ou fechada)
        if (index === -1) return null;
        return index + 1; // índice começa em 0, então somamos 1 para a posição real
    }

    /**
     * consulta o tempo medio de espera histórico de um departamento.
     * o período de análise retroativa é definido pela configuração `numberDays`, deixando o admin alterar na interface.
     * * @param departmentId ID do departamento alvo
     * @returns tempo medio de espera em segundos, ou `null` caso não haja dados suficientes
     */
    public async getAvgWaitingTime(
        departmentId: string,
    ): Promise<number | null> {
        const { start, end } = getDateRange(this.config.numberDays ?? 3); // padrão 3 dias

        const url =
            `${ROCKET_URL}/api/v1/livechat/analytics/departments/average-waiting-time` +
            `?start=${encodeURIComponent(start)}` +
            `&end=${encodeURIComponent(end)}` +
            `&departmentId=${departmentId}`;

        const response = await this.http.get(url, { headers: this.headers });
        const data = response.data as IAvgWaitingTimeResponse;

        if (!data?.departments || data.departments.length === 0) return null;
        return data.departments[0].averageWaitingTimeInSeconds ?? null;
    }

    /**
     * envia uma mensagem de texto para uma sala de livechat utilizando a identidade do proprio App.
     * * @param room objeto da sala destino onde a mensagem sera injetada
     * @param message conteúdo da mensagem a ser enviada
     * @param read acessor de leitura para identificar o usuario do App
     * @param modify acessor de modificação para construir e despachar a mensagem
     */
    public async sendMessageToVisitor(
        room: ILivechatRoom,
        message: string,
        read: IRead,
        modify: IModify,
    ): Promise<void> {
        const appUser = await read.getUserReader().getAppUser();
        if (!appUser) {
            throw new Error("App user not found");
        }
        const builder = modify.getCreator().startMessage();
        builder.setRoom(room).setSender(appUser).setText(message);

        await modify.getCreator().finish(builder);
    }

    /**
     * Resolve o ID do departamento de um agente específico.
     * Utilizado para calcular o tempo médio de fila quando o cliente é transferido para um agente.
     */
    public async getAgentDepartmentId(agentId: string): Promise<string | null> {
        const url = `${ROCKET_URL}/api/v1/livechat/users/agent/${agentId}`;
        try {
            const response = await this.http.get(url, {
                headers: this.headers,
            });
            const data = response.data as any;
            // Tenta obter o departamento vinculado ao perfil do agente
            return (
                data?.user?.departmentId || data?.agent?.departmentId || null
            );
        } catch (e) {
            return null;
        }
    }
}
