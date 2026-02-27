import {
    IPersistence,
    IPersistenceRead,
} from "@rocket.chat/apps-engine/definition/accessors";
import {
    RocketChatAssociationModel,
    RocketChatAssociationRecord,
} from "@rocket.chat/apps-engine/definition/metadata";

import { IQueuePersistenceData } from "../interfaces/IQueuePersistenceData";

export class PersistenceService {
    constructor(
        private readonly persistence: IPersistence,
        private readonly persistenceRead: IPersistenceRead,
    ) {}

    public async updateRoomPosition(
        roomId: string,
        position: number,
    ): Promise<void> {
        const association = new RocketChatAssociationRecord(
            RocketChatAssociationModel.ROOM,
            `last-position-${roomId}`,
        );
        const data: IQueuePersistenceData = { position };

        await this.persistence.updateByAssociation(association, data, true);
    }

    public async getLastPosition(roomId: string): Promise<number | null> {
        const association = new RocketChatAssociationRecord(
            RocketChatAssociationModel.ROOM,
            `last-position-${roomId}`,
        );

        const [result] =
            await this.persistenceRead.readByAssociation(association);

        if (result && "position" in result) {
            const data = result as IQueuePersistenceData;
            return data.position ?? null;
        }

        return null;
    }

    public async isRoomNotified(roomId: string): Promise<boolean> {
        const association = new RocketChatAssociationRecord(
            RocketChatAssociationModel.ROOM,
            `fila-iniciada-${roomId}`,
        );
        const result =
            await this.persistenceRead.readByAssociation(association);
        return result && result.length > 0;
    }

    public async markAsNotified(roomId: string): Promise<void> {
        const association = new RocketChatAssociationRecord(
            RocketChatAssociationModel.ROOM,
            `fila-iniciada-${roomId}`,
        );
        await this.persistence.createWithAssociation(
            { notified: true },
            association,
        );
    }

    public async clearRoomData(roomId: string): Promise<void> {
        const associations = [
            new RocketChatAssociationRecord(
                RocketChatAssociationModel.ROOM,
                `fila-iniciada-${roomId}`,
            ),
            new RocketChatAssociationRecord(
                RocketChatAssociationModel.ROOM,
                `last-position-${roomId}`,
            ),
        ];

        for (const assoc of associations) {
            await this.persistence.removeByAssociation(assoc);
        }
    }
}
