# Cotação — página do vendedor (Spazio Gourmet)

Página onde o vendedor responde a cotação da Spazio pelo link que o Ivan manda no WhatsApp:
`https://spaziogourmet.github.io/cotacao/#c=<código>` (prévia do Ivan: `#c=<código>&p=1`, só leitura).

- HTML/JS puro (ES2017, sem módulos, sem bibliotecas, só `fetch`), para abrir no navegador do WhatsApp em Android simples.
- Fala só com duas funções do Supabase do App de Compras, com a chave anônima: `cotacao_abrir` e `cotacao_responder`.
- O código da cotação fica depois do `#` (não vai para log nem para Referer); `?c=` é ignorado.
- Tudo o que vem do banco aparece como texto (`textContent`). A página nunca recebe nem mostra último preço ou custo médio.
- As regras estão no repositório privado `compra-semanal`: `docs/DESIGN-cotacao-fornecedores.md` (seção 9) e `docs/contrato-1b.md` (seção 9).

Arquivos publicados: `index.html`, `app.js`, `estilo.css`, `config.js`, `logo.png` (topo; some se não carregar) e `previa.jpg` (prévia do link no WhatsApp). `package.json`, `package-lock.json` e `tests/` servem só para os testes.

## Testes

Node 22 ou mais novo:

```
npm install
npm test
```

Rodam no jsdom com o banco simulado (nada sai para a internet): leitura do preço, conversão e conta ao vivo, rascunho no aparelho, envio com `envio_id`, `rev` por item, conflito, avisos, "devagar", condições incompletas que nunca seguram os preços (o erro fica junto do campo e o aviso do rodapé leva até ele — `tests/condicoes.test.js`, cenário do teste real de 28/09), estados da cotação, reabrir depois do fechamento (envio pendente refeito e aviso do que não chegou), prévia, nota do Ivan, marca e horário de recebimento.

## Preencher o `config.js` (na hora de publicar)

Enquanto os valores estiverem com os marcadores `__…__`, a página mostra "Página ainda não configurada" e não chama nada.

1. `SUPABASE_URL`: `https://ebghyejkwqebwhxcnlqx.supabase.co`
2. `SUPABASE_ANON_KEY`: a chave **anônima** do App (a mesma de `VITE_SUPABASE_ANON_KEY`). Nunca a de serviço (`service_role` ou `sb_secret_…`): o `npm test` recusa.
3. `RECEBIMENTO`: já vem com o horário da Spazio. Se mudar, mude também o `RECEBIMENTO` de `src/cotacao/mensagens.ts` no App (os dois textos são iguais). Vazio: a linha do horário some da página.

## Publicar no GitHub Pages

1. `npm test` (tudo verde).
2. No `compra-semanal`: `python scripts/checar_publico.py "<caminho desta pasta>"` — bloqueia se achar nome ou telefone real.
3. Repositório **público** `spaziogourmet/cotacao` (se o nome estiver ocupado, `spazio-gourmet`), sem workflow e sem segredo:
   ```
   git remote add origin https://github.com/spaziogourmet/cotacao.git
   git add -A
   git commit -m "Página do vendedor"
   git push -u origin main
   ```
   (`node_modules/` fica fora pelo `.gitignore`.)
4. No GitHub: Settings → Pages → Build and deployment → Source "Deploy from a branch", branch `main`, pasta `/ (root)` → Save.
5. Conferir em alguns minutos: `https://spaziogourmet.github.io/cotacao/` sem código mostra "Este link não vale mais…", e o "Ver como o vendedor vê" do App abre a cotação com a faixa "Prévia — nada é enviado".

Se o endereço mudar (ex.: `spazio-gourmet`), troque também o `og:image` do `index.html` e o `VITE_COTACAO_URL` do App.
