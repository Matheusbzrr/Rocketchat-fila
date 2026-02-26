export interface ILivechatRoomItem {
    _id: string;
    waitingResponse: boolean;
    servedBy?: { _id: string; username: string };
}
export interface ILivechatRoomsResponse {
    rooms: ILivechatRoomItem[];
    count: number;
    total: number;
    success: boolean;
}
