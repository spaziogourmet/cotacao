// Configuração pública da página do vendedor (contrato-1b.md, 9.2).
// SUPABASE_URL e SUPABASE_ANON_KEY são públicos por natureza (os mesmos do bundle do App) e só são preenchidos na publicação.
// Enquanto estiverem com os marcadores __…__, a página mostra "Página ainda não configurada" e não chama nada.
window.COTACAO_CONFIG = {
  SUPABASE_URL: 'https://ebghyejkwqebwhxcnlqx.supabase.co',           // na publicação: https://ebghyejkwqebwhxcnlqx.supabase.co
  SUPABASE_ANON_KEY: 'sb_publishable_3RzdNZ0vWePAXo5zwqky8Q_eJ-HIKaf', // na publicação: a mesma chave anônima do App (VITE_SUPABASE_ANON_KEY)
  RECEBIMENTO: 'seg a sex, 7h–11h e 14h–18h; sáb, 7h–11h e 14h–16h' // horário em que a Spazio recebe mercadoria (decisão do Ivan, 27/09)
}
