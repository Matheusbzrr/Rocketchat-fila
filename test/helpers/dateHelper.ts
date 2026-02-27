/**
 * retorna o intervalo de datas para a janela de análise
 * @param days número de dias para olhar para trás
 */
export function getDateRange(days: number): { start: string; end: string } {
    const end = new Date();
    const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return {
        start: start.toISOString(),
        end: end.toISOString(),
    };
}

/**
 * converte segundos para minutos arredondados para cima
 * exemplo: 512 segundos → 9 minutos
 */
export function secondsToMinutes(seconds: number): number {
    return Math.ceil(seconds / 60);
}
