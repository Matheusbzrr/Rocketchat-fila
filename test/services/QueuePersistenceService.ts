import {
    IPersistence,
    IPersistenceRead,
} from "@rocket.chat/apps-engine/definition/accessors";
import {
    RocketChatAssociationModel,
    RocketChatAssociationRecord,
} from "@rocket.chat/apps-engine/definition/metadata";

import { IQueuePersistenceData } from "../interfaces/IQueuePersistenceData";

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

    // ==============================
    // POSITION
    // ==============================

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
            return (result as IQueuePersistenceData).position ?? null;
        }

        return null;
    }

    // ==============================
    // QUEUE NOTIFICATION
    // ==============================

    public async isQueueNotified(roomId: string): Promise<boolean> {
        const association = new RocketChatAssociationRecord(
            RocketChatAssociationModel.ROOM,
            `queue-notified-${roomId}`,
        );

        const result =
            await this.persistenceRead.readByAssociation(association);
        return result && result.length > 0;
    }

    public async markQueueNotified(roomId: string): Promise<void> {
        const association = new RocketChatAssociationRecord(
            RocketChatAssociationModel.ROOM,
            `queue-notified-${roomId}`,
        );

        await this.persistence.createWithAssociation(
            { value: true },
            association,
        );
    }

    // ==============================
    // ASSIGNMENT (transfer / direct)
    // ==============================

    public async isAssignedNotified(roomId: string): Promise<boolean> {
        const association = new RocketChatAssociationRecord(
            RocketChatAssociationModel.ROOM,
            `assigned-notified-${roomId}`,
        );

        const result =
            await this.persistenceRead.readByAssociation(association);
        return result && result.length > 0;
    }

    public async markAssignedNotified(roomId: string): Promise<void> {
        const association = new RocketChatAssociationRecord(
            RocketChatAssociationModel.ROOM,
            `assigned-notified-${roomId}`,
        );

        await this.persistence.createWithAssociation(
            { value: true },
            association,
        );
    }

    // ==============================
    // CLEANUP
    // ==============================

    public async clearRoomData(roomId: string): Promise<void> {
        const associations = [
            `queue-notified-${roomId}`,
            `assigned-notified-${roomId}`,
            `last-position-${roomId}`,
        ];

        for (const key of associations) {
            const assoc = new RocketChatAssociationRecord(
                RocketChatAssociationModel.ROOM,
                key,
            );
            await this.persistence.removeByAssociation(assoc);
        }
    }
}
