interface IDepartmentWaitingTime {
    _id: string;
    averageWaitingTimeInSeconds: number;
}

export interface IAvgWaitingTimeResponse {
    departments: IDepartmentWaitingTime[];
    count: number;
    total: number;
    success: boolean;
}
