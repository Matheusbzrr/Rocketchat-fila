import {
    IConfigurationExtend,
    IRead,
} from "@rocket.chat/apps-engine/definition/accessors";
import { SettingType } from "@rocket.chat/apps-engine/definition/settings";

// IDs das settings — use esses IDs para ler os valores em qualquer lugar do app
export const SETTINGS = {
    API_TOKEN: "api_token",
    ADMIN_ID: "admin_id",
    NUMBER_DAYS: "number_days",
    MIN_QUEUE_SIZE: "min_queue_size",
};

/**
 * Registra as settings que aparecem na aba de configuração do app no painel admin
 */
export async function registerSettings(
    configuration: IConfigurationExtend,
): Promise<void> {
    await configuration.settings.provideSetting({
        id: SETTINGS.API_TOKEN,
        type: SettingType.STRING,
        packageValue: "",
        required: true,
        public: false,
        i18nLabel: "Admin Auth Token",
    });

    await configuration.settings.provideSetting({
        id: SETTINGS.ADMIN_ID,
        type: SettingType.STRING,
        packageValue: "",
        required: true,
        public: false,
        i18nLabel: "Admin User ID",
    });

    await configuration.settings.provideSetting({
        id: SETTINGS.NUMBER_DAYS,
        type: SettingType.NUMBER,
        packageValue: 0,
        required: true,
        public: false,
        i18nLabel: "Número de dias para otimizar a média de espera",
    });

    await configuration.settings.provideSetting({
        id: SETTINGS.MIN_QUEUE_SIZE,
        type: SettingType.NUMBER,
        packageValue: 0,
        required: true,
        public: false,
        i18nLabel: "Quantidade mínima na fila para notificar",
    });
}

/**
 * Lê as credenciais configuradas pelo admin
 * Retorna null se alguma credencial não estiver configurada
 */
export async function getCredentials(read: IRead): Promise<{
    token: string;
    userId: string;
    number_days: number;
    min_queue_size: number;
} | null> {
    const settings = read.getEnvironmentReader().getSettings();

    const token = await settings.getValueById(SETTINGS.API_TOKEN);
    const userId = await settings.getValueById(SETTINGS.ADMIN_ID);
    const number_days = await settings.getValueById(SETTINGS.NUMBER_DAYS);
    const min_queue_size = await settings.getValueById(SETTINGS.MIN_QUEUE_SIZE);

    if (!token || !userId || number_days <= 0 || min_queue_size <= 0)
        return null;

    return { token, userId, number_days, min_queue_size };
}
