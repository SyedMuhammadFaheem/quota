export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export async function sendTelegram(config: TelegramConfig, message: string): Promise<boolean> {
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: config.chatId, text: message }),
  });
  return res.ok;
}
