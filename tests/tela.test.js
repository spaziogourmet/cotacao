'use strict';
// Tela da página do vendedor no jsdom, com o banco simulado (fetch falso): spec 15.5 e contrato 9.
// Dados 100% inventados (Fulano, itens genéricos, preços redondos).
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const A = require('./ajuda');

const DIA = 86400000;
const AGORA = Date.UTC(2026, 9, 19, 19, 10);   // seg 19/10 16h10 em Brasília (o celular do teste)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WHATS = 'Se não funcionar, responda pelo WhatsApp com o número do item e o preço.';
const RECEBIMENTO = 'seg a sex, 7h–11h e 14h–18h; sáb, 7h–11h e 14h–16h';

const abertas = [];
afterEach(() => {
  while (abertas.length) {
    try { abertas.pop().w.close(); } catch (e) { /* já fechada */ }
  }
});

async function abrir(op) {
  const p = A.abrirPagina(op);
  abertas.push(p);
  await A.carregada(p);
  return p;
}

function servidor(extra) {
  return A.servidorFalso(A.abertura(extra));
}

const id = (p, x) => A.porId(p, x);
const texto = (p, x) => id(p, x).textContent;
const clicar = (p, x) => id(p, x).click();
const digitar = (p, x, t) => A.digitar(p, id(p, x), t);
const visivel = (p, x) => !id(p, x).hidden;
const itemTexto = (p, n, sel) => p.doc.querySelector('#item-' + n + ' ' + sel).textContent;
const h = (codigo) => A.hDe(A.carregarPuras(), codigo);
const ls = (p) => p.w.localStorage;

/** Estado da abertura para as telas que não são o formulário (contrato 5.1: mesmas chaves, itens vazios). */
function abertaEm(estado, texto_, extra) {
  return A.abertura(Object.assign({
    estado: estado, texto: texto_, itens: [], gerais: null, gerais_rev: 0, validade_opcoes: [], nova: null
  }, extra || {}));
}

function httpDe(json) {
  return Promise.resolve(A.respostaHttp(200, json));
}

describe('abertura, topo e endereço', () => {
  test('chama cotacao_abrir com o código do "#", p_previa false e a chave no apikey (sem Authorization para sb_publishable_)', async () => {
    const s = servidor();
    await abrir({ servidor: s });
    assert.equal(s.chamadas.length, 1);
    const c = s.chamadas[0];
    assert.equal(c.url, 'https://teste.supabase.co/rest/v1/rpc/cotacao_abrir');
    assert.equal(c.init.method, 'POST');
    assert.deepEqual(c.corpo, { p_codigo: A.CODIGO, p_previa: false });
    assert.equal(c.headers.apikey, 'sb_publishable_teste');
    assert.equal(c.headers['Content-Type'], 'application/json');
    assert.equal(c.headers.Accept, 'application/json');
    assert.equal(c.headers.Authorization, undefined);
  });

  test('chave anônima legada (JWT, "eyJ…") vai também no Authorization', async () => {
    const s = servidor();
    const config = "window.COTACAO_CONFIG = { SUPABASE_URL: 'https://teste.supabase.co', SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiJ9.teste.assinatura' }";
    await abrir({ servidor: s, config: config });
    assert.equal(s.chamadas[0].headers.Authorization, 'Bearer eyJhbGciOiJIUzI1NiJ9.teste.assinatura');
    assert.equal(s.chamadas[0].headers.apikey, 'eyJhbGciOiJIUzI1NiJ9.teste.assinatura');
  });

  test('topo, faixa "COTAÇÃO", prazo, contador e referrer', async () => {
    const p = await abrir({ servidor: servidor() });
    assert.equal(texto(p, 'titulo'), 'Spazio Gourmet · Cotação para Fulano · v1');
    assert.ok(visivel(p, 'faixa-cotacao'));
    assert.equal(texto(p, 'faixa-cotacao'), 'COTAÇÃO — ainda não é pedido. O Ivan confirma o pedido pelo WhatsApp.');
    assert.equal(texto(p, 'prazo'), 'Responder até terça, 20/10, 12h');
    assert.equal(texto(p, 'contador'), '0 de 5 preenchidos');
    assert.equal(p.doc.querySelector('meta[name="referrer"]').getAttribute('content'), 'no-referrer');
    assert.equal(visivel(p, 'faixa-pendente'), false);
    assert.equal(visivel(p, 'faixa-previa'), false);
    assert.equal(id(p, 'enviar').disabled, true, 'nada para enviar');
  });

  test('v2 e complementar no topo', async () => {
    const v2 = await abrir({ servidor: servidor({ versao: 2, substitui_versao: 1 }) });
    assert.equal(texto(v2, 'titulo'), 'Spazio Gourmet · Cotação para Fulano · v2');
    assert.equal(texto(v2, 'subtitulo'), 'Cotação v2 — substitui a v1; os números dos itens continuam os mesmos, itens novos no fim');
    const comp = await abrir({ servidor: servidor({ versao: 3, complementar: true }) });
    assert.equal(texto(comp, 'titulo'), 'Spazio Gourmet · Cotação para Fulano · complementar');
    assert.equal(texto(comp, 'subtitulo'), 'Cotação complementar — itens novos desta semana');
  });

  test('"?c=" é ignorado: sem "#c=" o link não vale e nada é chamado', async () => {
    const s = servidor();
    const p = await abrir({ servidor: s, url: A.BASE_URL + '?c=' + A.CODIGO });
    assert.equal(p.doc.querySelector('.estado-texto').textContent, 'Este link não vale mais. Peça um novo ao Ivan pelo WhatsApp.');
    assert.equal(s.chamadas.length, 0);
    const s2 = servidor();
    await abrir({ servidor: s2, url: A.BASE_URL + '?c=' + A.CODIGO_VELHO + '#c=' + A.CODIGO });
    assert.equal(s2.chamadas[0].corpo.p_codigo, A.CODIGO, 'vale só o do "#"');
  });

  test('código fora do formato não chama o banco (não gasta o balde de inválidos)', async () => {
    const s = servidor();
    const p = await abrir({ servidor: s, hash: '#c=curto' });
    assert.equal(p.doc.querySelector('.estado-texto').textContent, 'Este link não vale mais. Peça um novo ao Ivan pelo WhatsApp.');
    assert.equal(s.chamadas.length, 0);
  });

  test('config.js com os marcadores: "Página ainda não configurada" e nenhuma chamada', async () => {
    const s = servidor();
    // o config.js publicado já vem preenchido; aqui vale o do repositório antes da publicação
    const marcadores = "window.COTACAO_CONFIG = { SUPABASE_URL: '__SUPABASE_URL__', SUPABASE_ANON_KEY: '__SUPABASE_ANON_KEY__' }";
    const p = await abrir({ servidor: s, config: marcadores });
    assert.equal(p.doc.querySelector('.estado-texto').textContent, 'Página ainda não configurada.');
    assert.equal(s.chamadas.length, 0);
  });

  test('logo.png aparece quando carrega e some quando falha', async () => {
    const p = await abrir({ servidor: servidor() });
    const logo = id(p, 'logo');
    assert.equal(logo.getAttribute('src'), 'logo.png');
    assert.equal(logo.getAttribute('alt'), 'Spazio Gourmet');
    logo.dispatchEvent(new p.w.Event('load'));
    assert.equal(logo.hidden, false);
    logo.dispatchEvent(new p.w.Event('error'));
    assert.equal(logo.hidden, true);
  });
});

describe('cartão do item', () => {
  test('nota do Ivan logo abaixo do nome; sem nota, nada', async () => {
    const ab = A.abertura();
    ab.itens[0].nota = 'fardo c/12';
    const p = await abrir({ servidor: A.servidorFalso(ab) });
    const nota = id(p, 'item-1-nota');
    assert.equal(nota.textContent, 'fardo c/12');
    assert.ok(nota.previousElementSibling.classList.contains('item-cabecalho'), 'logo depois do nome');
    assert.equal(p.doc.getElementById('item-2-nota'), null);
    assert.equal(itemTexto(p, 1, '.item-nota'), 'Na última nota: AGUA MIN S/GAS 500ML (cód. 7890001)');
  });

  test('texto do banco com "<script>" e HTML aparece como texto (vendedor, nome, nota do Ivan, descrição, estado)', async () => {
    const ab = A.abertura({ vendedor_nome: '<script>window.__xss = 1</script>Fulano' });
    ab.itens[0].nome = '<img src=x onerror="window.__xss = 2">ÁGUA';
    ab.itens[0].nota = '<b>fardo c/12</b><script>window.__xss = 3</script>';
    ab.itens[0].descricao_fornecedor = '<i>AGUA</i>';
    const p = await abrir({ servidor: A.servidorFalso(ab) });
    assert.equal(p.w.__xss, undefined);
    assert.equal(p.doc.querySelectorAll('#item-1 b, #item-1 i, #item-1 img, #item-1 script').length, 0);
    assert.equal(texto(p, 'item-1-nota'), '<b>fardo c/12</b><script>window.__xss = 3</script>');
    assert.ok(texto(p, 'item-1-nome').indexOf('<img src=x') >= 0);
    assert.ok(itemTexto(p, 1, '.item-nota').indexOf('<i>AGUA</i>') >= 0);
    assert.ok(texto(p, 'titulo').indexOf('<script>') >= 0);

    const est = await abrir({ servidor: A.servidorFalso(abertaEm('cancelada', '<script>window.__xss = 4</script>Cancelada')) });
    assert.equal(est.w.__xss, undefined);
    assert.equal(est.doc.querySelector('.estado-texto').textContent, '<script>window.__xss = 4</script>Cancelada');
  });

  test('quantidade com rótulo: fator confirmado, saco, kg e líquido', async () => {
    const p = await abrir({ servidor: servidor() });
    assert.equal(itemTexto(p, 1, '.item-qtd'), '60 un → 5 fardos c/12 (60 un)');
    assert.equal(itemTexto(p, 2, '.item-qtd'), '104 un');
    assert.equal(itemTexto(p, 3, '.item-qtd'), '1,2 kg — cote o kg ou a sua embalagem e diga o peso');
    assert.equal(itemTexto(p, 4, '.item-qtd'), '19,9 kg no nosso sistema — cote o litro ou a caixa e diga os ml');
    assert.equal(itemTexto(p, 5, '.item-qtd'), '3 sacos');
  });

  test('rótulo "saco": [1 saco] [fardo com ___ sacos]', async () => {
    const p = await abrir({ servidor: servidor() });
    assert.equal(texto(p, 'item-5-base-unidade'), '1 saco');
    assert.equal(texto(p, 'item-5-base-emb'), 'fardo com');
    assert.equal(itemTexto(p, 5, '.opcao-emb .sufixo'), 'sacos');
    digitar(p, 'item-5-preco', '10');
    clicar(p, 'item-5-base-unidade');
    assert.equal(texto(p, 'item-5-conta'), 'R$ 10,00 o saco × 3 sacos = R$ 30,00');
  });

  test('opções de litro: [1 L] [embalagem de ___ ml] e "Vendo por kg" em Mais opções; kg tem "Vendo por litro"', async () => {
    const s = servidor();
    const p = await abrir({ servidor: s });
    assert.equal(texto(p, 'item-4-base-unidade'), '1 L');
    assert.equal(texto(p, 'item-4-base-emb'), 'embalagem de');
    assert.equal(itemTexto(p, 4, '.opcao-emb .sufixo'), 'ml');
    assert.equal(visivel(p, 'item-4-mais'), false);
    clicar(p, 'item-4-mais-botao');
    assert.equal(visivel(p, 'item-4-mais'), true);
    assert.equal(texto(p, 'item-4-modo'), 'Vendo por kg');
    assert.equal(texto(p, 'item-3-modo'), 'Vendo por litro');

    digitar(p, 'item-4-preco', '8');
    clicar(p, 'item-4-base-unidade');
    assert.equal(texto(p, 'item-4-conta'), 'R$ 8,00 o litro', 'sem kg_por_litro, sem conversão');
    clicar(p, 'item-3-mais-botao');
    clicar(p, 'item-3-modo');
    assert.equal(texto(p, 'item-3-base-unidade'), '1 L');
    digitar(p, 'item-3-preco', '9');
    clicar(p, 'item-3-base-emb');
    digitar(p, 'item-3-emb', '900');
    await p.C.enviar();
    const itens = s.ultimoEnvio().p_itens;
    assert.equal(itens[0].numero, 3);
    assert.equal(itens[0].base, 'embalagem');
    assert.equal(itens[0].emb_ml, 900);
    assert.equal(itens[0].emb_gramas, null);
    assert.equal(itens[1].numero, 4);
    assert.equal(itens[1].base, 'litro');
  });

  test('fator confirmado vem marcado e editável; sem fator nenhum número é sugerido', async () => {
    const p = await abrir({ servidor: servidor() });
    assert.equal(id(p, 'item-1-base-emb').getAttribute('aria-pressed'), 'true');
    assert.equal(id(p, 'item-1-emb').value, '12');
    assert.equal(id(p, 'item-3-emb').value, '');
    assert.equal(id(p, 'item-3-base-unidade').getAttribute('aria-pressed'), 'false');
    assert.equal(id(p, 'item-3-base-emb').getAttribute('aria-pressed'), 'false');
  });

  test('preço sem máscara: o valor interpretado aparece grande e a conta ao vivo acompanha', async () => {
    const p = await abrir({ servidor: servidor() });
    digitar(p, 'item-2-preco', '31,5');
    assert.equal(texto(p, 'item-2-valor'), 'R$ 31,50');
    assert.equal(id(p, 'item-2-preco').getAttribute('inputmode'), 'decimal');
    clicar(p, 'item-2-base-emb');
    digitar(p, 'item-2-emb', '6');
    assert.equal(texto(p, 'item-2-conta'), 'R$ 31,50 a embalagem c/6 = R$ 5,25 a un · 18 embalagens (108 un) = R$ 567,00');
    digitar(p, 'item-3-preco', '31');
    clicar(p, 'item-3-base-unidade');
    assert.equal(texto(p, 'item-3-conta'), 'R$ 31,00/kg × 1,2 kg = R$ 37,20');
    digitar(p, 'item-1-preco', '31.50');
    assert.equal(texto(p, 'item-1-conta'), 'R$ 31,50 o fardo c/12 = R$ 2,63 a un · 5 fardos (60 un) = R$ 157,50');
    digitar(p, 'item-2-preco', '10,555');
    assert.equal(texto(p, 'item-2-valor'), 'Use até 2 casas depois da vírgula');
    assert.equal(texto(p, 'contador'), '3 de 5 preenchidos');
  });

  test('nunca mostra último preço nem custo médio (mesmo se viessem por engano)', async () => {
    const ab = A.abertura();
    Object.assign(ab.itens[1], { ref_preco: 12.34, ref_situacao: 'ok', custo_medio: 11.11, qtd_sugerida: 777, avisos_ivan: ['unidade_suspeita'] });
    const p = await abrir({ servidor: A.servidorFalso(ab) });
    // o que aparece na tela (o body do teste também tem o app.js embutido, que cita esses nomes em comentário)
    const tudo = Array.from(p.doc.querySelectorAll('.topo, .fixo, #conteudo, #rodape')).map((n) => n.textContent).join(' ');
    for (const t of ['12,34', '12.34', '11,11', '11.11', '777', 'unidade_suspeita', 'último preço', 'custo']) {
      assert.equal(tudo.indexOf(t), -1, t);
    }
  });
});

describe('Marca (Mais opções)', () => {
  test('campo "Marca:" até 60 caracteres; vai no envio só com "tem"', async () => {
    const s = servidor();
    const p = await abrir({ servidor: s });
    clicar(p, 'item-2-mais-botao');
    const marca = id(p, 'item-2-marca');
    assert.equal(marca.getAttribute('maxlength'), '60');
    assert.equal(p.doc.querySelector('label[for="item-2-marca"]').textContent, 'Marca:');
    digitar(p, 'item-2-preco', '35');
    clicar(p, 'item-2-base-unidade');
    digitar(p, 'item-2-marca', ' Marca A ');
    clicar(p, 'item-3-mais-botao');
    digitar(p, 'item-3-marca', 'Marca B');
    clicar(p, 'item-3-nao-tem');
    assert.equal(id(p, 'item-3-marca').parentNode.hidden, true, 'sem a linha da marca no "não tenho"');
    await p.C.enviar();
    const [i2, i3] = s.ultimoEnvio().p_itens;
    assert.equal(i2.marca, 'Marca A');
    assert.equal(i3.estado, 'nao_tem');
    assert.equal('marca' in i3, false);
    assert.equal(s.respostas[2].marca_informada, 'Marca A');
    assert.equal(visivel(p, 'faixa-pendente'), false, 'a resposta com a marca volta igual');
  });

  test('marca_informada gravada volta no campo, com Mais opções aberto', async () => {
    const ab = A.abertura();
    ab.itens[1].resposta = A.respostaDe({ estado: 'tem', preco: 35, base: 'un', marca: 'Marca C' });
    ab.itens[1].rev = 1;
    const p = await abrir({ servidor: A.servidorFalso(ab) });
    assert.equal(visivel(p, 'item-2-mais'), true);
    assert.equal(id(p, 'item-2-marca').value, 'Marca C');
    assert.equal(texto(p, 'item-2-situacao'), 'Recebido');
    assert.equal(visivel(p, 'faixa-pendente'), false);
  });
});

describe('ENVIAR', () => {
  test('só os itens alterados, cada um com o rev que a página conhece; o rev devolvido vale no envio seguinte', async () => {
    const s = servidor();
    const p = await abrir({ servidor: s });
    digitar(p, 'item-1-preco', '31,50');
    digitar(p, 'item-3-preco', '12,40');
    clicar(p, 'item-3-base-emb');
    digitar(p, 'item-3-emb', '400');
    assert.ok(visivel(p, 'faixa-pendente'));
    assert.equal(texto(p, 'faixa-pendente'), 'AINDA NÃO ENVIADO — toque para tentar de novo');
    assert.equal(texto(p, 'item-1-situacao'), 'Ainda não enviado');
    assert.equal(id(p, 'enviar').disabled, false);
    await p.C.enviar();
    const c1 = s.ultimoEnvio();
    assert.match(c1.p_envio_id, UUID);
    assert.equal(c1.p_codigo, A.CODIGO);
    assert.equal(c1.p_gerais, null);
    assert.deepEqual(c1.p_itens.map((x) => x.numero), [1, 3]);
    assert.deepEqual(c1.p_itens[0], {
      numero: 1, rev_lida: 0, estado: 'tem', preco: 31.5, base: 'embalagem', emb_unidades: 12, emb_gramas: null, emb_ml: null,
      tenho_so: null, similar_desc: null, similar_preco: null, a_partir_de: null, marca: null, confirmado: false
    });
    assert.equal(c1.p_itens[1].emb_gramas, 400);
    assert.equal(visivel(p, 'faixa-pendente'), false);
    assert.equal(texto(p, 'status'), 'Recebido às 16h12');
    assert.equal(texto(p, 'item-1-situacao'), 'Recebido');

    // correção depois de "Recebido": envio_id novo, rev_lida = o rev devolvido (1), gravado sem conflito
    digitar(p, 'item-1-preco', '30');
    assert.ok(visivel(p, 'faixa-pendente'));
    await p.C.enviar();
    const c2 = s.ultimoEnvio();
    assert.notEqual(c2.p_envio_id, c1.p_envio_id);
    assert.deepEqual(c2.p_itens.map((x) => [x.numero, x.rev_lida]), [[1, 1]]);
    assert.equal(s.revs[1], 2);
    assert.equal(p.doc.querySelector('#item-1 .conflito').hidden, true);
    assert.equal(visivel(p, 'faixa-pendente'), false);
  });

  test('toque na faixa vermelha manda de novo; sem rede, a nova tentativa usa o mesmo envio_id', async () => {
    const s = servidor();
    s.interceptar = (nome) => (nome === 'cotacao_responder' && s.responderes().length === 1 ? Promise.reject(new TypeError('Failed to fetch')) : undefined);
    const p = await abrir({ servidor: s });
    digitar(p, 'item-2-preco', '35');
    clicar(p, 'item-2-base-unidade');
    await p.C.enviar();
    assert.ok(visivel(p, 'faixa-pendente'));
    assert.ok(texto(p, 'status').indexOf('Não consegui confirmar o envio.') >= 0);
    assert.ok(texto(p, 'status').indexOf(WHATS) >= 0);
    clicar(p, 'faixa-pendente');
    await A.esperar(() => s.responderes().length === 2 && !visivel(p, 'faixa-pendente'));
    const [a, b] = s.responderes();
    assert.equal(b.corpo.p_envio_id, a.corpo.p_envio_id);
    assert.equal(texto(p, 'status'), 'Recebido às 16h12');
  });

  test('HTTP ≠ 200 e JSON ilegível contam como "não confirmado" e repetem o mesmo envio_id', async () => {
    const s = servidor();
    s.interceptar = (nome) => {
      if (nome !== 'cotacao_responder') return undefined;
      const n = s.responderes().length;
      if (n === 1) return Promise.resolve(A.respostaHttp(500, { message: 'erro' }));
      if (n === 2) return Promise.resolve({ status: 200, ok: true, json: () => Promise.reject(new SyntaxError('JSON')) });
      return undefined;
    };
    const p = await abrir({ servidor: s });
    digitar(p, 'item-2-preco', '35');
    clicar(p, 'item-2-base-unidade');
    await p.C.enviar();
    assert.ok(visivel(p, 'faixa-pendente'));
    await p.C.enviar();
    assert.ok(visivel(p, 'faixa-pendente'));
    await p.C.enviar();
    assert.equal(visivel(p, 'faixa-pendente'), false);
    const ids = s.responderes().map((c) => c.corpo.p_envio_id);
    assert.equal(new Set(ids).size, 1);
  });

  test('resposta perdida: o banco gravou; o reenvio do mesmo envio_id devolve o resultado gravado (reenvio)', async () => {
    const s = servidor();
    s.interceptar = (nome, corpo) => {
      if (nome === 'cotacao_responder' && s.responderes().length === 1) {
        s.responder(corpo);
        return Promise.reject(new TypeError('conexão caiu na volta'));
      }
      return undefined;
    };
    const p = await abrir({ servidor: s });
    digitar(p, 'item-2-preco', '35');
    clicar(p, 'item-2-base-unidade');
    await p.C.enviar();
    assert.ok(visivel(p, 'faixa-pendente'));
    await p.C.enviar();
    assert.equal(Object.keys(s.envios).length, 1, 'gravado uma vez só');
    assert.equal(s.revs[2], 1);
    assert.equal(visivel(p, 'faixa-pendente'), false);
    assert.equal(ls(p).getItem('cot:' + h(A.CODIGO) + ':2'), null);
  });

  test('resposta perdida e um item voltado ao valor antigo antes do reenvio: o reenvio mostra a diferença e o seguimento manda a volta', async () => {
    const s = servidor();
    s.interceptar = (nome, corpo) => {
      if (nome === 'cotacao_responder' && s.responderes().length === 1) {
        s.responder(corpo);
        return Promise.reject(new TypeError('conexão caiu na volta'));
      }
      return undefined;
    };
    const p = await abrir({ servidor: s });
    digitar(p, 'item-2-preco', '42');
    clicar(p, 'item-2-base-unidade');
    digitar(p, 'item-3-preco', '12');
    clicar(p, 'item-3-base-unidade');
    await p.C.enviar();
    digitar(p, 'item-2-preco', '');   // o 2 volta ao vazio; o 3 continua pendente e puxa o reenvio
    await p.C.enviar();
    const r = s.responderes();
    assert.equal(r.length, 3, 'reenvio + seguimento');
    assert.equal(r[1].corpo.p_envio_id, r[0].corpo.p_envio_id);
    assert.deepEqual(r[2].corpo.p_itens.map((x) => [x.numero, x.rev_lida, x.estado]), [[2, 1, 'sem_resposta']]);
    assert.equal(s.respostas[2].estado, 'sem_resposta');
    assert.equal(s.respostas[3].preco_digitado, 12);
    assert.equal(texto(p, 'item-2-situacao'), '');
    assert.equal(texto(p, 'item-3-situacao'), 'Recebido');
    assert.equal(visivel(p, 'faixa-pendente'), false);
  });

  test('resposta perdida e o Ivan mudou o item depois: o reenvio (rev antigo) não apaga o rascunho nem mostra "Recebido" com valor diferente do banco', async () => {
    const s = servidor();
    s.interceptar = (nome, corpo) => {
      if (nome === 'cotacao_responder' && s.responderes().length === 1) {
        s.responder(corpo);
        return Promise.reject(new TypeError('conexão caiu na volta'));
      }
      return undefined;
    };
    const p1 = await abrir({ servidor: s });
    digitar(p1, 'item-2-preco', '42');
    clicar(p1, 'item-2-base-unidade');
    await p1.C.enviar();
    const primeiro = s.ultimoEnvio().p_envio_id;
    assert.equal(s.revs[2], 1, 'o 42 chegou ao banco (rev 1), mas a resposta se perdeu');
    // o Ivan digita R$ 50,00 no item 2 pelo App (rev 2)
    const cinquenta = A.respostaDe({ estado: 'tem', preco: 50, base: 'un' });
    s.revs[2] = 2;
    s.respostas[2] = cinquenta;
    s.abertura.itens[1].resposta = A.copia(cinquenta);
    s.abertura.itens[1].rev = 2;

    const p = await abrir({ servidor: s, storage: A.storageDe(p1) });
    assert.equal(id(p, 'item-2-preco').value, '42');
    assert.equal(texto(p, 'item-2-situacao'), 'Ainda não enviado');
    await p.C.enviar();
    const r = s.responderes();
    assert.equal(r[1].corpo.p_envio_id, primeiro, 'reenvio do mesmo envio_id: o banco devolve o resultado antigo (rev 1, R$ 42)');
    assert.equal(r.length, 3, 'reenvio + seguimento');
    assert.deepEqual(r[2].corpo.p_itens.map((x) => [x.numero, x.rev_lida, x.preco]), [[2, 0, 42]], 'o seguimento leva o rev que o vendedor viu');
    assert.equal(s.respostas[2].preco_digitado, 50, 'o banco continua com o valor do Ivan');
    const conflito = p.doc.querySelector('#item-2 .conflito');
    assert.equal(conflito.hidden, false);
    assert.equal(conflito.querySelector('p').textContent, 'Este item foi alterado depois que você abriu: R$ 50,00.');
    assert.equal(texto(p, 'item-2-manter'), 'Manter o meu R$ 42,00');
    assert.equal(texto(p, 'item-2-ficar'), 'Ficar com R$ 50,00');
    assert.equal(texto(p, 'item-2-situacao'), 'Ainda não enviado', 'nunca "Recebido" com R$ 42 na tela e R$ 50 no banco');
    assert.ok(texto(p, 'status').indexOf('Recebido') < 0);
    assert.ok(visivel(p, 'faixa-pendente'));
    assert.ok(ls(p).getItem('cot:' + h(A.CODIGO) + ':2'), 'o rascunho continua no aparelho');

    clicar(p, 'item-2-manter');
    await p.C.enviar();
    assert.deepEqual(s.ultimoEnvio().p_itens.map((x) => [x.numero, x.rev_lida, x.preco]), [[2, 2, 42]]);
    assert.equal(s.respostas[2].preco_digitado, 42);
    assert.equal(texto(p, 'item-2-situacao'), 'Recebido');
    assert.equal(visivel(p, 'faixa-pendente'), false);
  });

  test('aba fechada sem confirmação: ao reabrir, a faixa volta e o envio usa o mesmo envio_id', async () => {
    const s = servidor();
    s.interceptar = (nome) => (nome === 'cotacao_responder' && s.responderes().length === 1 ? Promise.reject(new TypeError('sem rede')) : undefined);
    const p1 = await abrir({ servidor: s });
    digitar(p1, 'item-2-preco', '35');
    clicar(p1, 'item-2-base-unidade');
    await p1.C.enviar();
    const primeiro = s.ultimoEnvio().p_envio_id;
    const guardado = A.storageDe(p1);
    assert.ok(guardado['cot:' + h(A.CODIGO) + ':envio']);

    const p2 = await abrir({ servidor: s, storage: guardado });
    assert.ok(visivel(p2, 'faixa-pendente'), 'a faixa vermelha volta');
    assert.equal(id(p2, 'item-2-preco').value, '35');
    await p2.C.enviar();
    assert.equal(s.ultimoEnvio().p_envio_id, primeiro);
    assert.equal(visivel(p2, 'faixa-pendente'), false);
  });

  test('"devagar": tenta de novo sozinha, esperando espera_s, com o mesmo envio_id', async () => {
    const s = servidor();
    const devagar = { ok: false, erro: 'devagar', texto: 'Aguarde alguns segundos.', espera_s: 3 };
    s.interceptar = (nome) => (nome === 'cotacao_responder' && s.responderes().length <= 2 ? httpDe(devagar) : undefined);
    const p = await abrir({ servidor: s, rapido: true });
    digitar(p, 'item-2-preco', '35');
    clicar(p, 'item-2-base-unidade');
    await p.C.enviar();
    assert.equal(s.responderes().length, 3);
    assert.equal(new Set(s.responderes().map((c) => c.corpo.p_envio_id)).size, 1);
    assert.deepEqual(p.esperas.filter((ms) => ms >= 1000), [3000, 3000]);
    assert.equal(visivel(p, 'faixa-pendente'), false);
  });

  test('"devagar" sem parar: no máximo 5 tentativas sozinha; depois fica a faixa vermelha', async () => {
    const s = servidor();
    s.interceptar = (nome) => (nome === 'cotacao_responder' ? httpDe({ ok: false, erro: 'devagar', texto: 'Muitas tentativas; tente em alguns minutos.', espera_s: 60 }) : undefined);
    const p = await abrir({ servidor: s, rapido: true });
    digitar(p, 'item-2-preco', '35');
    clicar(p, 'item-2-base-unidade');
    await p.C.enviar();
    assert.equal(s.responderes().length, 6);
    assert.deepEqual(p.esperas.filter((ms) => ms >= 1000), [60000, 60000, 60000, 60000, 60000]);
    assert.ok(visivel(p, 'faixa-pendente'));
    assert.equal(texto(p, 'mensagem'), 'Muitas tentativas; tente em alguns minutos.');
    assert.equal(id(p, 'enviar').disabled, false);
  });

  test('conflito por item: mostra o valor atual; os outros itens gravam; "Manter o meu" manda de novo com o rev atual', async () => {
    const s = servidor();
    s.revs[2] = 1;   // o Ivan digitou depois que a página abriu
    s.respostas[2] = A.respostaDe({ estado: 'tem', preco: 40, base: 'un' });
    const p = await abrir({ servidor: s });
    digitar(p, 'item-2-preco', '35');
    clicar(p, 'item-2-base-unidade');
    clicar(p, 'item-3-nao-tem');
    await p.C.enviar();
    assert.equal(s.respostas[3].estado, 'nao_tem');
    assert.equal(texto(p, 'item-3-situacao'), 'Recebido');
    const conflito = p.doc.querySelector('#item-2 .conflito');
    assert.equal(conflito.hidden, false);
    assert.equal(conflito.querySelector('p').textContent, 'Este item foi alterado depois que você abriu: R$ 40,00.');
    assert.equal(texto(p, 'item-2-manter'), 'Manter o meu R$ 35,00');
    assert.equal(texto(p, 'item-2-ficar'), 'Ficar com R$ 40,00');
    assert.ok(ls(p).getItem('cot:' + h(A.CODIGO) + ':2'), 'o conflito mantém o rascunho');
    assert.equal(ls(p).getItem('cot:' + h(A.CODIGO) + ':3'), null, 'o gravado sai do aparelho');
    assert.ok(visivel(p, 'faixa-pendente'));

    clicar(p, 'item-2-manter');
    await p.C.enviar();
    assert.deepEqual(s.ultimoEnvio().p_itens.map((x) => [x.numero, x.rev_lida, x.preco]), [[2, 1, 35]]);
    assert.equal(s.respostas[2].preco_digitado, 35);
    assert.equal(conflito.hidden, true);
    assert.equal(visivel(p, 'faixa-pendente'), false);
  });

  test('conflito: "Ficar com" o valor atual descarta o meu', async () => {
    const s = servidor();
    s.revs[2] = 1;
    s.respostas[2] = A.respostaDe({ estado: 'tem', preco: 40, base: 'un' });
    const p = await abrir({ servidor: s });
    digitar(p, 'item-2-preco', '35');
    clicar(p, 'item-2-base-unidade');
    await p.C.enviar();
    clicar(p, 'item-2-ficar');
    assert.equal(id(p, 'item-2-preco').value, '40,00');
    assert.equal(ls(p).getItem('cot:' + h(A.CODIGO) + ':2'), null);
    assert.equal(visivel(p, 'faixa-pendente'), false);
  });

  /** Segura a 1ª resposta do cotacao_responder (o banco já gravou) até o teste chamar s.soltar(). */
  function segurarPrimeiroEnvio(s) {
    s.soltar = null;
    s.interceptar = (nome, corpo) => {
      if (nome !== 'cotacao_responder' || s.responderes().length !== 1) return undefined;
      const json = s.responder(corpo);
      return new Promise((resolver) => { s.soltar = () => resolver(A.respostaHttp(200, json)); });
    };
  }

  test('voltar o item ao valor antigo enquanto o ENVIAR está no ar: fica "Ainda não enviado" e o próximo envio manda a volta', async () => {
    const s = servidor();
    segurarPrimeiroEnvio(s);
    const p = await abrir({ servidor: s });
    digitar(p, 'item-2-preco', '42');
    clicar(p, 'item-2-base-unidade');
    const envio = p.C.enviar();
    await A.esperar(() => !!s.soltar);
    digitar(p, 'item-2-preco', '');   // apagou antes da resposta: igual ao que a página conhecia (vazio)
    s.soltar();
    await envio;
    assert.equal(s.respostas[2].preco_digitado, 42, 'o banco ficou com 42');
    assert.equal(id(p, 'item-2-preco').value, '');
    assert.equal(texto(p, 'item-2-situacao'), 'Ainda não enviado');
    assert.ok(visivel(p, 'faixa-pendente'));
    assert.ok(ls(p).getItem('cot:' + h(A.CODIGO) + ':2'), 'a volta fica no aparelho');
    await p.C.enviar();
    assert.deepEqual(s.ultimoEnvio().p_itens.map((x) => [x.numero, x.rev_lida, x.estado]), [[2, 1, 'sem_resposta']]);
    assert.equal(s.respostas[2].estado, 'sem_resposta');
    assert.equal(texto(p, 'item-2-situacao'), '');
    assert.equal(visivel(p, 'faixa-pendente'), false);
  });

  test('voltar o item ao valor antigo durante o envio que dá conflito: a escolha aparece (sem fingir "Recebido")', async () => {
    const s = servidor();
    segurarPrimeiroEnvio(s);
    const p = await abrir({ servidor: s });
    s.revs[2] = 1;   // o Ivan digitou depois que a página abriu
    s.respostas[2] = A.respostaDe({ estado: 'tem', preco: 40, base: 'un' });
    digitar(p, 'item-2-preco', '35');
    clicar(p, 'item-2-base-unidade');
    const envio = p.C.enviar();
    await A.esperar(() => !!s.soltar);
    digitar(p, 'item-2-preco', '');
    s.soltar();
    await envio;
    const conflito = p.doc.querySelector('#item-2 .conflito');
    assert.equal(conflito.hidden, false);
    assert.equal(conflito.querySelector('p').textContent, 'Este item foi alterado depois que você abriu: R$ 40,00.');
    assert.equal(texto(p, 'item-2-situacao'), 'Ainda não enviado');
    assert.ok(visivel(p, 'faixa-pendente'));
    clicar(p, 'item-2-ficar');
    assert.equal(id(p, 'item-2-preco').value, '40,00');
    assert.equal(texto(p, 'item-2-situacao'), 'Recebido');
    assert.equal(ls(p).getItem('cot:' + h(A.CODIGO) + ':2'), null);
    assert.equal(visivel(p, 'faixa-pendente'), false);
  });

  test('avisos "Confira" montados na página; "Está certo" é um envio novo com confirmado: true', async () => {
    const s = servidor();
    s.avisos[3] = ['centavos'];
    s.avisos[2] = ['valor_alto'];
    s.avisos[1] = ['fator_diferente'];
    const p = await abrir({ servidor: s });
    digitar(p, 'item-3-preco', '0,42');
    clicar(p, 'item-3-base-unidade');
    digitar(p, 'item-2-preco', '400');
    clicar(p, 'item-2-base-unidade');
    digitar(p, 'item-1-preco', '100');
    digitar(p, 'item-1-emb', '10');
    await p.C.enviar();
    const primeiro = s.ultimoEnvio().p_envio_id;
    const confira = (n) => Array.from(p.doc.querySelectorAll('#item-' + n + ' .confira-texto')).map((x) => x.textContent);
    assert.deepEqual(confira(3), ['R$ 0,42 — é isso mesmo? (não seria R$ 42,00?)']);
    assert.deepEqual(confira(2), ['R$ 400,00 por 1 un — confere? Não é o total da linha?']);
    assert.deepEqual(confira(1), ['O fardo não é de 12?']);
    assert.equal(visivel(p, 'faixa-pendente'), false, 'aviso não impede a gravação');

    clicar(p, 'item-3-esta-certo');
    assert.ok(visivel(p, 'faixa-pendente'));
    assert.equal(p.doc.querySelector('#item-3 .confira').hidden, true);
    await p.C.enviar();
    const c = s.ultimoEnvio();
    assert.notEqual(c.p_envio_id, primeiro);
    assert.deepEqual(c.p_itens.map((x) => [x.numero, x.rev_lida, x.preco, x.confirmado]), [[3, 1, 0.42, true]]);
    assert.equal(s.respostas[3].confirmado_pelo_vendedor, true);
    assert.equal(p.doc.querySelector('#item-3 .confira').hidden, true);
    assert.equal(p.doc.querySelector('#item-2 .confira').hidden, false);
  });

  test('erro local antes de mandar: nada sai e o item mostra o que falta', async () => {
    const s = servidor();
    const p = await abrir({ servidor: s });
    digitar(p, 'item-2-preco', '10');
    await p.C.enviar();
    assert.equal(s.responderes().length, 0);
    assert.equal(texto(p, 'mensagem'), 'Falta completar o item 2.');
    assert.equal(itemTexto(p, 2, '.erro-item'), 'Diga de que é o preço: toque em "1 un" ou em "fardo/caixa com …".');
    assert.ok(visivel(p, 'faixa-pendente'));
  });

  test('erro devolvido pelo banco fica no item e o rascunho continua', async () => {
    const s = servidor();
    s.interceptar = (nome) => (nome === 'cotacao_responder' ? httpDe({
      ok: true, reenvio: false, recebido_em: '2026-10-19T19:12:03.000000Z', gerais: null,
      itens: [{ numero: 2, resultado: 'erro', rev: 0, valor_atual: A.respostaVazia(), avisos_vendedor: [], erro: 'valor_invalido' }]
    }) : undefined);
    const p = await abrir({ servidor: s });
    digitar(p, 'item-2-preco', '35');
    clicar(p, 'item-2-base-unidade');
    await p.C.enviar();
    assert.equal(itemTexto(p, 2, '.erro-item'), 'Algum número deste item está fora do esperado. Confira.');
    assert.ok(ls(p).getItem('cot:' + h(A.CODIGO) + ':2'));
    assert.ok(visivel(p, 'faixa-pendente'));
  });

  test('recusa "estado" (a cotação fechou no caminho): mostra o texto do banco', async () => {
    const s = servidor();
    s.interceptar = (nome) => (nome === 'cotacao_responder' ? httpDe({
      ok: false, erro: 'estado', estado: 'encerrada', texto: 'Cotação encerrada às 17h de ter 20/10. Obrigado!', nova: null
    }) : undefined);
    const p = await abrir({ servidor: s });
    digitar(p, 'item-2-preco', '35');
    clicar(p, 'item-2-base-unidade');
    await p.C.enviar();
    assert.equal(p.doc.querySelector('.estado-texto').textContent, 'Cotação encerrada às 17h de ter 20/10. Obrigado!');
    assert.equal(visivel(p, 'rodape'), false);
    assert.equal(visivel(p, 'faixa-pendente'), false);
    // o que não chegou não some em silêncio: a tela diz o que mandar pelo WhatsApp
    assert.equal(texto(p, 'nao-chegou-texto'),
      'O preço do item 2 que você preencheu não chegou ao Ivan. Mande pelo WhatsApp com o número do item e o preço:');
    assert.deepEqual(Array.from(p.doc.querySelectorAll('#nao-chegou li')).map((x) => x.textContent), ['Item 2: R$ 35,00']);
  });

  test('recusa "estado" sem localStorage: o aviso do que não chegou vem da própria tela', async () => {
    const s = servidor();
    s.interceptar = (nome) => (nome === 'cotacao_responder' ? httpDe({
      ok: false, erro: 'estado', estado: 'encerrada', texto: 'Cotação encerrada às 17h de ter 20/10. Obrigado!', nova: null
    }) : undefined);
    const p = await abrir({ servidor: s, semStorage: true });
    digitar(p, 'item-2-preco', '35');
    clicar(p, 'item-2-base-unidade');
    clicar(p, 'gerais-pag-pix');
    await p.C.enviar();
    assert.equal(texto(p, 'nao-chegou-texto'),
      'O preço do item 2 e as condições que você preencheu não chegaram ao Ivan. Mande pelo WhatsApp com o número do item e o preço:');
    assert.deepEqual(Array.from(p.doc.querySelectorAll('#nao-chegou li')).map((x) => x.textContent), ['Item 2: R$ 35,00', 'Condições: Pix']);
  });

  test('recusa "limite": mostra o texto e o que não foi enviado continua pendente', async () => {
    const s = servidor();
    const t = 'Muitos envios nesta cotação. Se precisar corrigir algo, responda pelo WhatsApp com o número do item e o preço.';
    s.interceptar = (nome) => (nome === 'cotacao_responder' ? httpDe({ ok: false, erro: 'limite', texto: t }) : undefined);
    const p = await abrir({ servidor: s });
    digitar(p, 'item-2-preco', '35');
    clicar(p, 'item-2-base-unidade');
    await p.C.enviar();
    assert.equal(texto(p, 'mensagem'), t);
    assert.ok(visivel(p, 'faixa-pendente'));
  });

  test('"Pronto! Se quiser, avise o Ivan no WhatsApp" depois do Recebido, sem número de telefone', async () => {
    const p = await abrir({ servidor: servidor() });
    assert.equal(visivel(p, 'pronto'), false);
    digitar(p, 'item-2-preco', '35');
    clicar(p, 'item-2-base-unidade');
    await p.C.enviar();
    assert.equal(visivel(p, 'pronto'), true);
    assert.equal(texto(p, 'avisar-ivan'), 'Pronto! Se quiser, avise o Ivan no WhatsApp');
    assert.equal(id(p, 'avisar-ivan').getAttribute('href'), 'https://wa.me/?text=' + encodeURIComponent('Ivan, respondi a cotação da Spazio (v1).'));
  });
});

describe('rascunho no aparelho', () => {
  test('guardado por cotação e por número (com t) e apagado quando o banco confirma', async () => {
    const s = servidor();
    const p = await abrir({ servidor: s, relogio: { agora: AGORA } });
    digitar(p, 'item-2-preco', '35');
    clicar(p, 'item-2-base-unidade');
    const k = 'cot:' + h(A.CODIGO) + ':2';
    const r = JSON.parse(ls(p).getItem(k));
    assert.equal(r.t, AGORA);
    assert.equal(r.rev, 0);
    assert.equal(r.v.preco, '35');
    // a entrada já validada vai junto (contrato 9.5): depois do fechamento é com ela que a página sabe se chegou
    assert.equal(r.e.estado, 'tem');
    assert.equal(r.e.preco, 35);
    assert.equal(r.e.base, 'un');
    digitar(p, 'item-3-preco', '10');
    assert.equal(JSON.parse(ls(p).getItem('cot:' + h(A.CODIGO) + ':3')).e, null, 'incompleto (sem "de que é o preço"): e = null');
    digitar(p, 'item-3-preco', '');
    await p.C.enviar();
    assert.equal(ls(p).getItem(k), null);
    assert.equal(ls(p).getItem('cot:' + h(A.CODIGO) + ':envio'), null);
  });

  test('reabrir com rascunho não enviado: os valores e a faixa vermelha voltam', async () => {
    const k = 'cot:' + h(A.CODIGO) + ':2';
    const storage = {};
    storage[k] = JSON.stringify({ t: AGORA - 13 * DIA, rev: 0, v: { preco: '35', base: 'unidade', modo: 'un' } });
    const p = await abrir({ servidor: servidor(), storage: storage, relogio: { agora: AGORA } });
    assert.equal(id(p, 'item-2-preco').value, '35');
    assert.ok(visivel(p, 'faixa-pendente'));
    assert.equal(texto(p, 'item-2-situacao'), 'Ainda não enviado');
  });

  test('rascunho com mais de 14 dias é descartado ao abrir', async () => {
    const k = 'cot:' + h(A.CODIGO) + ':2';
    const storage = {};
    storage[k] = JSON.stringify({ t: AGORA - 15 * DIA, rev: 0, v: { preco: '35', base: 'unidade', modo: 'un' } });
    const p = await abrir({ servidor: servidor(), storage: storage, relogio: { agora: AGORA } });
    assert.equal(ls(p).getItem(k), null);
    assert.equal(id(p, 'item-2-preco').value, '');
    assert.equal(visivel(p, 'faixa-pendente'), false);
  });

  test('rascunho da semana passada (outro código) nunca aparece, mesmo com o mesmo número de item', async () => {
    const hv = h(A.CODIGO_VELHO);
    const storage = {};
    storage['cot:' + hv + ':2'] = JSON.stringify({ t: AGORA - DIA, rev: 0, v: { preco: '99', base: 'unidade', modo: 'un' } });
    storage['cot:' + hv + ':gerais'] = JSON.stringify({ t: AGORA - DIA, rev: 0, v: { pag: 'pix' } });
    const p = await abrir({ servidor: servidor(), storage: storage, relogio: { agora: AGORA } });
    assert.equal(id(p, 'item-2-preco').value, '');
    assert.equal(id(p, 'gerais-pag-pix').getAttribute('aria-pressed'), 'false');
    assert.equal(visivel(p, 'faixa-pendente'), false);
    assert.equal(p.doc.getElementById('levar'), null);
    assert.ok(ls(p).getItem('cot:' + hv + ':2'), 'nem lê nem apaga o de outra cotação');
  });

  test('rascunho igual ao que o banco já tem é apagado ao abrir (nada a enviar)', async () => {
    const ab = A.abertura();
    ab.itens[1].resposta = A.respostaDe({ estado: 'tem', preco: 35, base: 'un' });
    ab.itens[1].rev = 1;
    const k = 'cot:' + h(A.CODIGO) + ':2';
    const storage = {};
    storage[k] = JSON.stringify({ t: AGORA, rev: 0, v: { preco: '35', base: 'unidade', modo: 'un' } });
    const p = await abrir({ servidor: A.servidorFalso(ab), storage: storage, relogio: { agora: AGORA } });
    assert.equal(ls(p).getItem(k), null);
    assert.equal(visivel(p, 'faixa-pendente'), false);
  });

  test('sem localStorage (bloqueado) a página funciona: preenche, envia e confirma', async () => {
    const s = servidor();
    const p = await abrir({ servidor: s, semStorage: true });
    digitar(p, 'item-2-preco', '35');
    clicar(p, 'item-2-base-unidade');
    assert.ok(visivel(p, 'faixa-pendente'));
    await p.C.enviar();
    assert.equal(s.respostas[2].preco_digitado, 35);
    assert.equal(texto(p, 'status'), 'Recebido às 16h12');
  });
});

describe('versão substituída e "Levar os preços"', () => {
  const nova = { versao: 2, codigo: A.CODIGO_2 };

  function servidorDuasVersoes() {
    const v2 = A.abertura({ versao: 2, substitui_versao: 1 });
    const s = A.servidorFalso(v2);
    s.abrir = (corpo) => A.copia(corpo.p_codigo === A.CODIGO ? abertaEm('substituida', 'Esta cotação foi atualizada (v2)', { nova: nova }) : v2);
    return s;
  }

  test('rascunho não enviado da v1 vai para a v2 pelo número, com conferência antes do ENVIAR', async () => {
    const h1 = h(A.CODIGO);
    const h2 = h(A.CODIGO_2);
    const storage = {};
    storage['cot:' + h1 + ':2'] = JSON.stringify({ t: AGORA, rev: 0, v: { preco: '35', base: 'unidade', modo: 'un' } });
    storage['cot:' + h1 + ':3'] = JSON.stringify({ t: AGORA, rev: 0, v: { nao_tem: true } });
    storage['cot:' + h1 + ':9'] = JSON.stringify({ t: AGORA, rev: 0, v: { preco: '50', base: 'unidade', modo: 'un' } });
    storage['cot:' + h1 + ':gerais'] = JSON.stringify({ t: AGORA, rev: 0, v: { pag: 'pix' } });
    const s = servidorDuasVersoes();
    const p = await abrir({ servidor: s, storage: storage, relogio: { agora: AGORA } });

    assert.equal(p.doc.querySelector('.estado-texto').textContent, 'Esta cotação foi atualizada (v2)');
    const link = id(p, 'abrir-nova');
    assert.equal(link.textContent, 'Abrir a versão nova');
    assert.equal(link.getAttribute('href'), '#c=' + A.CODIGO_2 + '&de=' + h1);
    assert.equal(p.doc.getElementById('nao-chegou'), null, 'na substituída o rascunho vai pelo "Levar os preços"');

    // abre a v2 pelo link (troca do "#")
    p.w.location.hash = link.getAttribute('href');
    await A.esperar(() => p.doc.querySelector('.item'));
    assert.equal(s.chamadas[s.chamadas.length - 1].corpo.p_codigo, A.CODIGO_2);
    assert.equal(p.w.location.hash, '#c=' + A.CODIGO_2, 'o "de" sai do endereço');
    assert.equal(id(p, 'item-2-preco').value, '', 'nada entra sozinho');
    assert.equal(visivel(p, 'faixa-pendente'), false);
    assert.equal(texto(p, 'levar-botao'), 'Levar os 2 preços que você ainda não enviou e as condições');

    clicar(p, 'levar-botao');
    assert.equal(id(p, 'item-2-preco').value, '35');
    assert.equal(id(p, 'item-3-nao-tem').getAttribute('aria-pressed'), 'true');
    assert.equal(id(p, 'gerais-pag-pix').getAttribute('aria-pressed'), 'true');
    assert.equal(p.doc.querySelector('#levar .aviso').textContent, 'Pronto. Confira os preços antes de tocar em ENVIAR.');
    assert.ok(visivel(p, 'faixa-pendente'));
    assert.equal(s.responderes().length, 0, 'não envia sozinho');
    assert.ok(ls(p).getItem('cot:' + h2 + ':2'));
    assert.equal(ls(p).getItem('cot:' + h1 + ':2'), null);
    assert.ok(ls(p).getItem('cot:' + h1 + ':9'), 'número que não existe na v2 não é levado');

    await p.C.enviar();
    const c = s.ultimoEnvio();
    assert.equal(c.p_codigo, A.CODIGO_2);
    assert.deepEqual(c.p_itens.map((x) => [x.numero, x.estado]), [[2, 'tem'], [3, 'nao_tem']]);
    assert.equal(c.p_gerais.pagamento, 'Pix');
  });

  function storageDaV1() {
    const h1 = h(A.CODIGO);
    const storage = {};
    storage['cot:' + h1 + ':2'] = JSON.stringify({ t: AGORA, rev: 0, v: { preco: '35', base: 'unidade', modo: 'un' } });
    storage['cot:' + h1 + ':3'] = JSON.stringify({ t: AGORA, rev: 0, v: { nao_tem: true } });
    storage['cot:' + h1 + ':gerais'] = JSON.stringify({ t: AGORA, rev: 0, v: { pag: 'pix' } });
    return storage;
  }

  test('digitar na v2 e depois tocar em Levar mantém o valor digitado (só leva o que não foi mexido)', async () => {
    const h1 = h(A.CODIGO);
    const h2 = h(A.CODIGO_2);
    const s = servidorDuasVersoes();
    const p = await abrir({ servidor: s, storage: storageDaV1(), hash: '#c=' + A.CODIGO_2 + '&de=' + h1, relogio: { agora: AGORA } });
    assert.equal(texto(p, 'levar-botao'), 'Levar os 2 preços que você ainda não enviou e as condições');

    digitar(p, 'item-2-preco', '40');
    clicar(p, 'item-2-base-unidade');
    clicar(p, 'gerais-pag-vista');
    clicar(p, 'levar-botao');

    assert.equal(id(p, 'item-2-preco').value, '40', 'o que foi digitado nesta versão vale mais');
    assert.equal(id(p, 'gerais-pag-vista').getAttribute('aria-pressed'), 'true');
    assert.equal(id(p, 'gerais-pag-pix').getAttribute('aria-pressed'), 'false');
    assert.equal(id(p, 'item-3-nao-tem').getAttribute('aria-pressed'), 'true', 'o item não mexido é levado');
    assert.equal(p.doc.querySelector('#levar .aviso').textContent,
      'Pronto. O que você já tinha mexido nesta versão ficou como estava. Confira os preços antes de tocar em ENVIAR.');
    assert.equal(JSON.parse(ls(p).getItem('cot:' + h2 + ':2')).v.preco, '40');
    assert.equal(ls(p).getItem('cot:' + h1 + ':2'), null, 'a oferta foi usada: o rascunho velho sai do aparelho');

    await p.C.enviar();
    const c = s.ultimoEnvio();
    assert.deepEqual(c.p_itens.map((x) => [x.numero, x.estado]), [[2, 'tem'], [3, 'nao_tem']]);
    assert.equal(s.respostas[2].preco_digitado, 40);
    assert.equal(c.p_gerais.pagamento, 'à vista');
  });

  test('item já enviado na v2 ("Recebido") não volta ao rascunho velho ao tocar em Levar', async () => {
    const h1 = h(A.CODIGO);
    const h2 = h(A.CODIGO_2);
    const s = servidorDuasVersoes();
    const p = await abrir({ servidor: s, storage: storageDaV1(), hash: '#c=' + A.CODIGO_2 + '&de=' + h1, relogio: { agora: AGORA } });
    digitar(p, 'item-2-preco', '40');
    clicar(p, 'item-2-base-unidade');
    clicar(p, 'item-3-nao-tem');
    clicar(p, 'gerais-pag-vista');
    await p.C.enviar();
    assert.equal(visivel(p, 'faixa-pendente'), false);
    const envios = s.responderes().length;

    clicar(p, 'levar-botao');
    assert.equal(id(p, 'item-2-preco').value, '40');
    assert.equal(id(p, 'gerais-pag-vista').getAttribute('aria-pressed'), 'true');
    assert.equal(ls(p).getItem('cot:' + h2 + ':2'), null, 'nenhum rascunho novo sobre o que já foi gravado');
    assert.equal(ls(p).getItem('cot:' + h2 + ':gerais'), null);
    assert.equal(visivel(p, 'faixa-pendente'), false, 'nada pendente para enviar');
    assert.equal(p.doc.querySelector('#levar .aviso').textContent, 'Nada foi trocado: você já preencheu esses itens nesta versão.');
    assert.equal(ls(p).getItem('cot:' + h1 + ':2'), null);
    assert.equal(s.responderes().length, envios, 'não envia sozinho');
  });

  test('sem rascunho da v1, o link da versão nova não leva "de"; na prévia continua prévia', async () => {
    const s = servidorDuasVersoes();
    const p = await abrir({ servidor: s });
    assert.equal(id(p, 'abrir-nova').getAttribute('href'), '#c=' + A.CODIGO_2);
    const pv = await abrir({ servidor: servidorDuasVersoes(), hash: '#c=' + A.CODIGO + '&p=1' });
    assert.equal(id(pv, 'abrir-nova').getAttribute('href'), '#c=' + A.CODIGO_2 + '&p=1');
  });
});

describe('estados de 5.4 (texto do banco)', () => {
  const casos = [
    ['encerrada', 'Cotação encerrada às 17h de ter 20/10. Obrigado!'],
    ['pedido_confirmado', 'O Ivan já confirmou o pedido com você pelo WhatsApp. Obrigado!'],
    ['encerrada_pelo_ivan', 'Cotação encerrada pelo Ivan em 20/10 às 10h15. Obrigado!'],
    ['cancelada', 'Esta cotação foi cancelada pelo Ivan.']
  ];
  for (const [estado, t] of casos) {
    test(estado + ': só o texto, sem formulário e sem link', async () => {
      const p = await abrir({ servidor: A.servidorFalso(abertaEm(estado, t)) });
      assert.equal(p.doc.querySelector('.estado-texto').textContent, t);
      assert.equal(p.doc.querySelector('.item'), null);
      assert.equal(p.doc.getElementById('abrir-nova'), null);
      assert.equal(visivel(p, 'faixa-cotacao'), false);
      assert.equal(visivel(p, 'rodape'), false);
      assert.equal(p.doc.getElementById('nao-chegou'), null, 'sem rascunho no aparelho, nenhum aviso');
    });
  }

  test('substituída: texto + [Abrir a versão nova]', async () => {
    const p = await abrir({ servidor: A.servidorFalso(abertaEm('substituida', 'Esta cotação foi atualizada (v2)', { nova: { versao: 2, codigo: A.CODIGO_2 } })) });
    assert.equal(p.doc.querySelector('.estado-texto').textContent, 'Esta cotação foi atualizada (v2)');
    assert.equal(id(p, 'abrir-nova').getAttribute('href'), '#c=' + A.CODIGO_2);
  });

  test('código inválido, limite e devagar ao abrir (ok: false)', async () => {
    const t1 = 'Este link não vale mais. Peça um novo ao Ivan pelo WhatsApp.';
    const s1 = servidor();
    s1.abrir = () => ({ ok: false, erro: 'codigo_invalido', texto: t1 });
    const p1 = await abrir({ servidor: s1 });
    assert.equal(p1.doc.querySelector('.estado-texto').textContent, t1);
    assert.equal(p1.doc.querySelector('.estado button'), null);

    const s2 = servidor();
    s2.abrir = () => ({ ok: false, erro: 'limite', texto: 'Muitas aberturas seguidas; tente em alguns minutos.' });
    const p2 = await abrir({ servidor: s2 });
    assert.equal(p2.doc.querySelector('.estado-texto').textContent, 'Muitas aberturas seguidas; tente em alguns minutos.');
    assert.equal(p2.doc.querySelector('.estado button').textContent, 'Tentar de novo');

    const s3 = servidor();
    let n = 0;
    s3.abrir = () => (++n === 1 ? { ok: false, erro: 'devagar', texto: 'Muitas tentativas; tente em alguns minutos.', espera_s: 60 } : A.copia(s3.abertura));
    const p3 = await abrir({ servidor: s3 });
    assert.equal(p3.doc.querySelector('.estado-texto').textContent, 'Muitas tentativas; tente em alguns minutos.');
    p3.doc.querySelector('.estado button').click();
    await A.esperar(() => p3.doc.querySelector('.item'));
  });

  test('rede caída ao abrir: pede para tentar de novo e mostra o plano B do WhatsApp', async () => {
    const s = servidor();
    s.interceptar = () => Promise.reject(new TypeError('sem rede'));
    const p = await abrir({ servidor: s });
    assert.equal(p.doc.querySelector('.estado-texto').textContent, 'Não consegui abrir a cotação. Confira a internet e tente de novo.');
    assert.ok(p.doc.querySelector('.estado').textContent.indexOf(WHATS) >= 0);
  });
});

describe('relógio do banco (não o do celular)', () => {
  test('fica só leitura quando acabam os segundos_para_fechar, com o celular na hora errada', async () => {
    const relogio = { agora: Date.UTC(2031, 0, 1) };   // celular com a data errada
    const s = servidor({ segundos_para_fechar: 120 });
    const p = await abrir({ servidor: s, relogio: relogio });
    assert.equal(texto(p, 'prazo'), 'O prazo era 12h, mas ainda dá para enviar até 17h de hoje');
    relogio.agora += 60 * 1000;
    p.C.atualizarRelogio();
    assert.equal(id(p, 'item-2-preco').disabled, false);
    relogio.agora += 61 * 1000;
    p.C.atualizarRelogio();
    assert.equal(texto(p, 'prazo'), 'Cotação encerrada às 17h de ter 20/10. Obrigado!');
    assert.equal(id(p, 'item-2-preco').disabled, true);
    assert.equal(id(p, 'item-2-base-unidade').disabled, true);
    assert.equal(id(p, 'enviar').disabled, true);
    digitar(p, 'item-2-preco', '35');
    assert.equal(visivel(p, 'faixa-pendente'), false, 'depois do fechamento nada vira rascunho');
  });

  test('envio pendente no fechamento ainda pode ser repetido (o banco aceita o que estava em trânsito)', async () => {
    const relogio = { agora: AGORA };
    const s = servidor({ segundos_para_fechar: 30 });
    s.interceptar = (nome) => (nome === 'cotacao_responder' && s.responderes().length === 1 ? Promise.reject(new TypeError('sem rede')) : undefined);
    const p = await abrir({ servidor: s, relogio: relogio });
    digitar(p, 'item-2-preco', '35');
    clicar(p, 'item-2-base-unidade');
    await p.C.enviar();
    relogio.agora += 31 * 1000;
    p.C.atualizarRelogio();
    assert.equal(id(p, 'item-2-preco').disabled, true);
    assert.equal(id(p, 'enviar').disabled, false);
    clicar(p, 'enviar');
    await A.esperar(() => s.responderes().length === 2 && !visivel(p, 'faixa-pendente'));
    assert.equal(s.responderes()[1].corpo.p_envio_id, s.responderes()[0].corpo.p_envio_id);
  });
});

describe('prévia (&p=1)', () => {
  test('só leitura: faixa "Prévia", p_previa true, sem ENVIAR, sem rascunho e sem cotacao_responder', async () => {
    const s = servidor();
    const p = await abrir({ servidor: s, hash: '#c=' + A.CODIGO + '&p=1' });
    assert.deepEqual(s.chamadas[0].corpo, { p_codigo: A.CODIGO, p_previa: true });
    assert.ok(visivel(p, 'faixa-previa'));
    assert.equal(texto(p, 'faixa-previa'), 'Prévia — nada é enviado.');
    assert.equal(visivel(p, 'rodape'), false);
    assert.equal(id(p, 'item-2-preco').disabled, true);
    assert.equal(id(p, 'gerais-pag-pix').disabled, true);
    clicar(p, 'item-2-mais-botao');
    assert.equal(visivel(p, 'item-2-mais'), true, '"Mais opções" continua abrindo');
    digitar(p, 'item-2-preco', '35');
    assert.equal(visivel(p, 'faixa-pendente'), false);
    assert.equal(ls(p).length, 0);
    await p.C.enviar();
    assert.equal(s.responderes().length, 0);
  });
});

describe('condições gerais', () => {
  test('validade com as datas absolutas do banco; horário de recebimento do config.js acima de "Se eu fechar, entrego em"', async () => {
    const p = await abrir({ servidor: servidor(), config: A.CONFIG_PUBLICADO });
    const rotulos = Array.from(p.doc.querySelectorAll('[aria-labelledby="gerais-val-rotulo"] .opcao')).map((b) => b.textContent);
    assert.deepEqual(rotulos, ['hoje 19/10', 'amanhã 20/10', 'qua 21/10', 'sex 23/10', 'outra data']);
    const linha = id(p, 'gerais-recebimento');
    assert.equal(linha.textContent, 'A Spazio recebe mercadoria: ' + RECEBIMENTO);
    const entrega = id(p, 'gerais-ent-rotulo');
    assert.equal(entrega.textContent, 'Se eu fechar, entrego em');
    assert.ok(linha.compareDocumentPosition(entrega) & p.w.Node.DOCUMENT_POSITION_FOLLOWING, 'acima de "Se eu fechar, entrego em"');
  });

  test('sem RECEBIMENTO no config.js, sem a linha do horário', async () => {
    const p = await abrir({ servidor: servidor(), config: A.CONFIG_TESTE });
    assert.equal(p.doc.getElementById('gerais-recebimento'), null);
  });

  test('vão uma vez, com gerais_rev; sem mudança, nada é mandado de novo', async () => {
    const s = servidor();
    const p = await abrir({ servidor: s });
    clicar(p, 'gerais-pag-boleto');
    digitar(p, 'gerais-pag-dias', '28');
    clicar(p, 'gerais-val-2026-10-21');
    clicar(p, 'gerais-min-sem');
    digitar(p, 'gerais-frete', '15');
    clicar(p, 'gerais-ent-seguinte');
    digitar(p, 'gerais-obs', 'Entrego até 10h.');
    assert.ok(visivel(p, 'faixa-pendente'));
    await p.C.enviar();
    const c = s.ultimoEnvio();
    assert.deepEqual(c.p_itens, []);
    assert.deepEqual(c.p_gerais, {
      rev_lida: 0, pagamento: 'boleto 28 dias', validade: '2026-10-21', pedido_minimo: 0, frete: 15, entrega: 'dia seguinte', observacao: 'Entrego até 10h.'
    });
    assert.equal(visivel(p, 'faixa-pendente'), false);
    assert.equal(texto(p, 'gerais-situacao'), 'Recebido');
    await p.C.enviar();
    assert.equal(s.responderes().length, 1);
  });

  test('conflito nas condições mostra as atuais; "Manter as minhas" manda com o gerais_rev atual', async () => {
    const s = servidor();
    s.geraisRev = 1;
    s.gerais = { pagamento: 'Pix', validade: null, pedido_minimo: null, frete: null, entrega: null, observacao: null };
    const p = await abrir({ servidor: s });
    clicar(p, 'gerais-pag-vista');
    await p.C.enviar();
    assert.equal(p.doc.querySelector('#gerais .conflito p').textContent, 'As condições foram alteradas depois que você abriu: Pix.');
    clicar(p, 'gerais-manter');
    await p.C.enviar();
    assert.equal(s.ultimoEnvio().p_gerais.rev_lida, 1);
    assert.equal(s.gerais.pagamento, 'à vista');
    assert.equal(visivel(p, 'faixa-pendente'), false);
  });

  test('condições voltadas ao valor antigo enquanto o ENVIAR está no ar: ficam "Ainda não enviado" e vão no próximo envio', async () => {
    const s = servidor();
    let soltar = null;
    s.interceptar = (nome, corpo) => {
      if (nome !== 'cotacao_responder' || s.responderes().length !== 1) return undefined;
      const json = s.responder(corpo);
      return new Promise((resolver) => { soltar = () => resolver(A.respostaHttp(200, json)); });
    };
    const p = await abrir({ servidor: s });
    digitar(p, 'gerais-frete', '15');
    const envio = p.C.enviar();
    await A.esperar(() => !!soltar);
    digitar(p, 'gerais-frete', '');
    soltar();
    await envio;
    assert.equal(s.gerais.frete, 15, 'o banco ficou com o frete 15');
    assert.equal(texto(p, 'gerais-situacao'), 'Ainda não enviado');
    assert.ok(visivel(p, 'faixa-pendente'));
    await p.C.enviar();
    const c = s.ultimoEnvio().p_gerais;
    assert.equal(c.rev_lida, 1);
    assert.equal(c.frete, null);
    assert.equal(s.gerais.frete, null);
    assert.equal(visivel(p, 'faixa-pendente'), false);
  });

  test('resposta perdida e o Ivan mudou as condições depois: o reenvio (rev antigo) não apaga o rascunho e a escolha aparece', async () => {
    const s = servidor();
    s.interceptar = (nome, corpo) => {
      if (nome === 'cotacao_responder' && s.responderes().length === 1) {
        s.responder(corpo);
        return Promise.reject(new TypeError('conexão caiu na volta'));
      }
      return undefined;
    };
    const p1 = await abrir({ servidor: s });
    digitar(p1, 'gerais-frete', '15');
    await p1.C.enviar();
    assert.equal(s.geraisRev, 1, 'o frete 15 chegou (rev 1), mas a resposta se perdeu');
    // o Ivan troca o frete para R$ 20,00 pelo App (rev 2)
    s.geraisRev = 2;
    s.gerais = { pagamento: null, validade: null, pedido_minimo: null, frete: 20, entrega: null, observacao: null };
    s.abertura.gerais = A.copia(s.gerais);
    s.abertura.gerais_rev = 2;

    const p = await abrir({ servidor: s, storage: A.storageDe(p1) });
    assert.equal(id(p, 'gerais-frete').value, '15');
    assert.equal(texto(p, 'gerais-situacao'), 'Ainda não enviado');
    await p.C.enviar();
    const r = s.responderes();
    assert.equal(r[1].corpo.p_envio_id, r[0].corpo.p_envio_id, 'reenvio: volta o resultado antigo (rev 1, frete 15)');
    assert.equal(r.length, 3, 'reenvio + seguimento');
    assert.equal(r[2].corpo.p_gerais.rev_lida, 0);
    assert.equal(s.gerais.frete, 20, 'o banco continua com o frete do Ivan');
    assert.equal(p.doc.querySelector('#gerais .conflito p').textContent, 'As condições foram alteradas depois que você abriu: frete R$ 20,00.');
    assert.equal(texto(p, 'gerais-situacao'), 'Ainda não enviado');
    assert.ok(visivel(p, 'faixa-pendente'));
    assert.ok(ls(p).getItem('cot:' + h(A.CODIGO) + ':gerais'));
    clicar(p, 'gerais-ficar');
    assert.equal(id(p, 'gerais-frete').value, '20,00');
    assert.equal(texto(p, 'gerais-situacao'), 'Recebido');
    assert.equal(visivel(p, 'faixa-pendente'), false);
  });
});

describe('reabrir depois do fechamento com o que não chegou (spec 9: a tela não diz só "Obrigado!")', () => {
  const ENCERRADA = 'Cotação encerrada às 17h de ter 20/10. Obrigado!';
  const hh = () => h(A.CODIGO);
  const linhas = (p) => Array.from(p.doc.querySelectorAll('#nao-chegou li')).map((x) => x.textContent);
  const destaCotacao = (p) => Object.keys(A.storageDe(p)).filter((k) => k.indexOf('cot:' + hh() + ':') === 0);

  /** O vendedor digita 2 (R$ 42) e 5 (R$ 9) e toca ENVIAR sem confirmação; devolve o que ficou no aparelho. */
  async function envioSemConfirmacao(s, depois) {
    const p = await abrir({ servidor: s });
    digitar(p, 'item-2-preco', '42');
    clicar(p, 'item-2-base-unidade');
    digitar(p, 'item-5-preco', '9');
    clicar(p, 'item-5-base-unidade');
    await p.C.enviar();
    assert.equal(texto(p, 'status').indexOf('Ainda não enviado. Não consegui confirmar o envio.'), 0);
    if (depois) depois(p);
    const guardado = A.storageDe(p);
    for (const k of [':2', ':5', ':envio']) assert.ok(guardado['cot:' + hh() + k], k);
    return guardado;
  }

  /** O vendedor reabre às 17h02: a abertura devolve 'encerrada' (sem itens). */
  function fechar(s) {
    s.abrir = () => A.copia(abertaEm('encerrada', ENCERRADA));
  }

  test('passou do fechamento + 5 min: refaz o envio pendente e, recusado, avisa que os itens 2 e 5 não chegaram, com o valor de cada um', async () => {
    const s = servidor();
    const recusa = { ok: false, erro: 'estado', estado: 'encerrada', texto: ENCERRADA, nova: null };
    s.interceptar = (nome) => {
      if (nome !== 'cotacao_responder') return undefined;
      return s.responderes().length === 1 ? Promise.reject(new TypeError('sem rede')) : httpDe(recusa);
    };
    const guardado = await envioSemConfirmacao(s);
    const primeiro = s.ultimoEnvio();
    fechar(s);

    const p = await abrir({ servidor: s, storage: guardado });
    assert.equal(p.doc.querySelector('.estado-texto').textContent, ENCERRADA);
    const r = s.responderes();
    assert.equal(r.length, 2, 'refaz o envio pendente uma vez');
    assert.equal(r[1].corpo.p_envio_id, primeiro.p_envio_id, 'mesmo envio_id');
    assert.deepEqual(r[1].corpo.p_itens, primeiro.p_itens, 'o corpo guardado no aparelho (a abertura depois do fechamento vem sem itens)');
    assert.equal(r[1].corpo.p_gerais, null);
    assert.equal(texto(p, 'nao-chegou-texto'),
      'Os preços dos itens 2 e 5 que você preencheu não chegaram ao Ivan. Mande pelo WhatsApp com o número do item e o preço:');
    assert.deepEqual(linhas(p), ['Item 2: R$ 42,00', 'Item 5: R$ 9,00']);
    assert.equal(p.doc.getElementById('chegou'), null);
    assert.equal(visivel(p, 'rodape'), false);
    assert.equal(ls(p).getItem('cot:' + hh() + ':envio'), null, 'o banco recusou: esse envio não vale mais');
    assert.ok(ls(p).getItem('cot:' + hh() + ':2'), 'o que não chegou continua no aparelho');
    assert.ok(ls(p).getItem('cot:' + hh() + ':5'));
  });

  test('ainda dentro dos 5 min de tolerância: o envio pendente chega e a tela diz "Seus preços chegaram às 16h12."', async () => {
    const s = servidor();
    s.interceptar = (nome) => (nome === 'cotacao_responder' && s.responderes().length === 1 ? Promise.reject(new TypeError('sem rede')) : undefined);
    const guardado = await envioSemConfirmacao(s);
    fechar(s);

    const p = await abrir({ servidor: s, storage: guardado });
    assert.equal(p.doc.querySelector('.estado-texto').textContent, ENCERRADA);
    assert.equal(s.responderes().length, 2);
    assert.equal(s.respostas[2].preco_digitado, 42);
    assert.equal(s.respostas[5].preco_digitado, 9);
    assert.equal(texto(p, 'chegou'), 'Seus preços chegaram às 16h12.');
    assert.equal(p.doc.getElementById('nao-chegou'), null);
    assert.deepEqual(destaCotacao(p), [], 'nada desta cotação fica no aparelho');
  });

  test('o envio tinha chegado (resposta perdida) e o item 5 foi mudado depois sem ENVIAR: o reenvio confirma o 2 e avisa o 5', async () => {
    const s = servidor();
    s.interceptar = (nome, corpo) => {
      if (nome === 'cotacao_responder' && s.responderes().length === 1) {
        s.responder(corpo);
        return Promise.reject(new TypeError('conexão caiu na volta'));
      }
      return undefined;
    };
    const guardado = await envioSemConfirmacao(s, (p) => digitar(p, 'item-5-preco', '10'));
    fechar(s);

    const p = await abrir({ servidor: s, storage: guardado });
    assert.equal(Object.keys(s.envios).length, 1, 'gravado uma vez só (reenvio)');
    assert.equal(texto(p, 'chegou'), 'O preço do item 2 chegou ao Ivan às 16h12.');
    assert.equal(texto(p, 'nao-chegou-texto'),
      'O preço do item 5 que você preencheu não chegou ao Ivan. Mande pelo WhatsApp com o número do item e o preço:');
    assert.deepEqual(linhas(p), ['Item 5: R$ 10,00']);
    assert.equal(ls(p).getItem('cot:' + hh() + ':2'), null, 'o 2 chegou: sai do aparelho');
    assert.ok(ls(p).getItem('cot:' + hh() + ':5'));
    assert.equal(ls(p).getItem('cot:' + hh() + ':envio'), null);
  });

  test('sem rede ao refazer o envio: avisa que não deu para confirmar, mostra o que ficou e "Tentar de novo" refaz com o mesmo envio_id', async () => {
    const s = servidor();
    s.interceptar = (nome) => (nome === 'cotacao_responder' && s.responderes().length <= 2 ? Promise.reject(new TypeError('sem rede')) : undefined);
    const guardado = await envioSemConfirmacao(s);
    const primeiro = s.ultimoEnvio().p_envio_id;
    fechar(s);

    const p = await abrir({ servidor: s, storage: guardado });
    assert.equal(texto(p, 'sem-confirmacao'), 'Não consegui confirmar se o seu último envio chegou. Confira a internet e toque em Tentar de novo.');
    assert.equal(texto(p, 'nao-chegou-texto'),
      'Os preços dos itens 2 e 5 que você preencheu não chegaram ao Ivan. Mande pelo WhatsApp com o número do item e o preço:');
    assert.ok(ls(p).getItem('cot:' + hh() + ':envio'), 'o envio fica guardado para a próxima tentativa');

    clicar(p, 'tentar-de-novo');
    await A.esperar(() => p.doc.getElementById('chegou'));
    assert.equal(texto(p, 'chegou'), 'Seus preços chegaram às 16h12.');
    assert.equal(s.responderes()[2].corpo.p_envio_id, primeiro);
    assert.equal(p.doc.getElementById('nao-chegou'), null);
    assert.equal(p.doc.getElementById('sem-confirmacao'), null);
  });

  test('substituída: o envio pendente que tinha chegado é confirmado e o link da versão nova não leva "de"', async () => {
    const s = servidor();
    s.interceptar = (nome, corpo) => {
      if (nome === 'cotacao_responder' && s.responderes().length === 1) {
        s.responder(corpo);
        return Promise.reject(new TypeError('conexão caiu na volta'));
      }
      return undefined;
    };
    const guardado = await envioSemConfirmacao(s);
    s.abrir = () => A.copia(abertaEm('substituida', 'Esta cotação foi atualizada (v2)', { nova: { versao: 2, codigo: A.CODIGO_2 } }));
    const p = await abrir({ servidor: s, storage: guardado });
    assert.equal(texto(p, 'chegou'), 'Seus preços chegaram às 16h12.');
    assert.equal(id(p, 'abrir-nova').getAttribute('href'), '#c=' + A.CODIGO_2, 'nada a levar para a v2');
    assert.equal(p.doc.getElementById('nao-chegou'), null);
    assert.deepEqual(destaCotacao(p), []);
  });

  test('substituída: o envio pendente que não chegou é recusado e o rascunho vai pelo "Levar os preços" (sem aviso aqui)', async () => {
    const s = servidor();
    const recusa = { ok: false, erro: 'estado', estado: 'substituida', texto: 'Esta cotação foi atualizada (v2)', nova: { versao: 2, codigo: A.CODIGO_2 } };
    s.interceptar = (nome) => {
      if (nome !== 'cotacao_responder') return undefined;
      return s.responderes().length === 1 ? Promise.reject(new TypeError('sem rede')) : httpDe(recusa);
    };
    const guardado = await envioSemConfirmacao(s);
    s.abrir = () => A.copia(abertaEm('substituida', 'Esta cotação foi atualizada (v2)', { nova: { versao: 2, codigo: A.CODIGO_2 } }));
    const p = await abrir({ servidor: s, storage: guardado });
    assert.equal(id(p, 'abrir-nova').getAttribute('href'), '#c=' + A.CODIGO_2 + '&de=' + hh());
    assert.equal(p.doc.getElementById('nao-chegou'), null);
    assert.equal(p.doc.getElementById('chegou'), null);
    assert.equal(ls(p).getItem('cot:' + hh() + ':envio'), null);
    assert.ok(ls(p).getItem('cot:' + hh() + ':2'));
  });

  test('prévia (&p=1) de cotação encerrada nunca refaz envio nem lê o rascunho', async () => {
    const s = servidor();
    s.interceptar = (nome) => (nome === 'cotacao_responder' && s.responderes().length === 1 ? Promise.reject(new TypeError('sem rede')) : undefined);
    const guardado = await envioSemConfirmacao(s);
    fechar(s);
    const p = await abrir({ servidor: s, storage: guardado, hash: '#c=' + A.CODIGO + '&p=1' });
    assert.equal(p.doc.querySelector('.estado-texto').textContent, ENCERRADA);
    assert.equal(s.responderes().length, 1, 'só o envio original');
    assert.equal(p.doc.getElementById('nao-chegou'), null);
    assert.ok(ls(p).getItem('cot:' + hh() + ':envio'), 'nada apagado');
  });

  test('preenchido sem tocar ENVIAR (item e condições): avisa o que ficou só no celular e não chama o cotacao_responder', async () => {
    const t = 'Cotação encerrada pelo Ivan em 20/10 às 10h15. Obrigado!';
    const storage = {};
    storage['cot:' + hh() + ':3'] = JSON.stringify({ t: AGORA, rev: 0, v: { nao_tem: true } });
    storage['cot:' + hh() + ':gerais'] = JSON.stringify({ t: AGORA, rev: 0, v: { pag: 'pix' } });
    const s = A.servidorFalso(abertaEm('encerrada_pelo_ivan', t));
    const p = await abrir({ servidor: s, storage: storage, relogio: { agora: AGORA } });
    assert.equal(p.doc.querySelector('.estado-texto').textContent, t);
    assert.equal(texto(p, 'nao-chegou-texto'),
      'O preço do item 3 e as condições que você preencheu não chegaram ao Ivan. Mande pelo WhatsApp com o número do item e o preço:');
    assert.deepEqual(linhas(p), ['Item 3: "Não tenho"', 'Condições: Pix']);
    assert.equal(s.responderes().length, 0);
  });

  test('texto do rascunho com "<b>" aparece como texto no aviso', async () => {
    const storage = {};
    storage['cot:' + hh() + ':gerais'] = JSON.stringify({ t: AGORA, rev: 0, v: { pag: 'outro', pag_outro: '<b>cheque</b><img src=x onerror="window.__xss = 5">' } });
    const p = await abrir({ servidor: A.servidorFalso(abertaEm('cancelada', 'Esta cotação foi cancelada pelo Ivan.')), storage: storage, relogio: { agora: AGORA } });
    assert.equal(texto(p, 'nao-chegou-texto'), 'As condições que você preencheu não chegaram ao Ivan. Mande pelo WhatsApp:');
    assert.deepEqual(linhas(p), ['Condições: <b>cheque</b><img src=x onerror="window.__xss = 5">']);
    assert.equal(p.doc.querySelectorAll('#nao-chegou b, #nao-chegou img').length, 0);
    assert.equal(p.w.__xss, undefined);
  });
});

describe('o dia virou com a aba aberta (chegou seg à tarde, termina ter de manhã)', () => {
  const HORA = 3600 * 1000;
  const NOITE_MS = Date.UTC(2026, 9, 20, 0, 30);   // seg 19/10 21h30 em Brasília
  const NOITE = { agora: '2026-10-20T00:30:00.000000Z', agora_local: '2026-10-19 21:30', segundos_para_fechar: 70200 };
  // o que o banco devolve na terça 8h (cot_validade_opcoes de terça: a quarta é "amanhã")
  const MANHA = {
    agora: '2026-10-20T11:00:00.000000Z', agora_local: '2026-10-20 08:00', segundos_para_fechar: 32400,
    validade_opcoes: [
      { data: '2026-10-20', rotulo: 'hoje 20/10' }, { data: '2026-10-21', rotulo: 'amanhã 21/10' }, { data: '2026-10-23', rotulo: 'sex 23/10' }
    ]
  };
  const DA_TERCA = ['hoje 20/10', 'amanhã 21/10', 'sex 23/10', 'outra data'];
  const rotulosValidade = (p) => Array.from(p.doc.querySelectorAll('[aria-labelledby="gerais-val-rotulo"] .opcao')).map((b) => b.textContent);
  const primeiroBotaoValidade = (p) => p.doc.querySelector('[aria-labelledby="gerais-val-rotulo"] .opcao');
  const aberturas = (s) => s.chamadas.filter((c) => c.nome === 'cotacao_abrir').length;
  const erroGerais = (p) => p.doc.querySelector('#gerais .erro-item');
  const ligado = (p, x) => id(p, x).getAttribute('aria-pressed') === 'true';
  const PASSOU = 'A data de validade já passou; escolha de novo.';

  /** O vendedor volta para a aba (o jsdom começa com a aba "escondida"). */
  function voltarAba(p) {
    Object.defineProperty(p.doc, 'hidden', { configurable: true, get: () => false });
    p.doc.dispatchEvent(new p.w.Event('visibilitychange'));
  }

  test('a tela da noite ficou aberta e ele toca "hoje 19/10" e ENVIAR às 8h: nada sai com a data de ontem; a tela volta com as datas de hoje e diz o porquê', async () => {
    const relogio = { agora: NOITE_MS };
    const s = servidor(NOITE);
    const p = await abrir({ servidor: s, relogio: relogio });
    assert.deepEqual(rotulosValidade(p), ['hoje 19/10', 'amanhã 20/10', 'qua 21/10', 'sex 23/10', 'outra data']);
    clicar(p, 'gerais-pag-pix');
    digitar(p, 'gerais-frete', '0');
    // o celular dorme; de manhã o banco já está na terça
    Object.assign(s.abertura, A.copia(MANHA));
    relogio.agora += 10.5 * HORA;
    // nenhum evento chegou: a tela ainda é a da noite, e o primeiro botão ainda diz "hoje 19/10"
    clicar(p, 'gerais-val-2026-10-19');
    await p.C.enviar();
    assert.equal(s.responderes().length, 0, 'a condição com a data de ontem não sai');
    assert.equal(aberturas(s), 2, 'reabriu a cotação: datas e revs de agora, rascunhos do aparelho');
    assert.deepEqual(rotulosValidade(p), DA_TERCA);
    assert.equal(id(p, 'gerais-val-data').getAttribute('min'), '2026-10-20');
    assert.equal(texto(p, 'prazo'), 'Responder até terça, 20/10, 12h');
    assert.ok(ligado(p, 'gerais-val-outra'), 'a data de ontem aparece em "outra data"');
    assert.equal(id(p, 'gerais-val-data').value, '2026-10-19');
    assert.equal(erroGerais(p).textContent, PASSOU);
    assert.equal(texto(p, 'mensagem'), 'Falta completar as condições.');
    assert.ok(ligado(p, 'gerais-pag-pix'), 'Pix continua');
    assert.equal(id(p, 'gerais-frete').value, '0');
    assert.equal(texto(p, 'gerais-situacao'), 'Ainda não enviado');

    primeiroBotaoValidade(p).click();   // agora é "hoje 20/10"
    assert.equal(erroGerais(p).hidden, true);
    await p.C.enviar();
    const c = s.ultimoEnvio().p_gerais;
    assert.equal(c.validade, '2026-10-20');
    assert.equal(c.pagamento, 'Pix');
    assert.equal(c.frete, 0);
    assert.equal(texto(p, 'gerais-situacao'), 'Recebido');
    assert.equal(visivel(p, 'faixa-pendente'), false);
  });

  test('ao voltar para a aba no dia seguinte, a cotação é reaberta com as datas de hoje; o preço e as condições da noite continuam', async () => {
    const relogio = { agora: NOITE_MS };
    const s = servidor(NOITE);
    const p = await abrir({ servidor: s, relogio: relogio });
    digitar(p, 'item-2-preco', '35');
    clicar(p, 'item-2-base-unidade');
    clicar(p, 'gerais-pag-pix');
    // voltar à aba no mesmo dia não reabre nada
    relogio.agora += HORA;
    voltarAba(p);
    assert.equal(aberturas(s), 1);
    Object.assign(s.abertura, A.copia(MANHA));
    relogio.agora += 9.5 * HORA;
    voltarAba(p);
    await A.esperar(() => aberturas(s) === 2 && p.doc.getElementById('gerais-val-2026-10-20'));
    assert.deepEqual(rotulosValidade(p), DA_TERCA);
    assert.equal(id(p, 'item-2-preco').value, '35');
    assert.ok(ligado(p, 'gerais-pag-pix'));
    assert.ok(visivel(p, 'faixa-pendente'));
    primeiroBotaoValidade(p).click();
    await p.C.enviar();
    const c = s.ultimoEnvio();
    assert.equal(c.p_gerais.validade, '2026-10-20');
    assert.equal(c.p_gerais.pagamento, 'Pix');
    assert.deepEqual(c.p_itens.map((x) => [x.numero, x.preco]), [[2, 35]]);
    assert.equal(visivel(p, 'faixa-pendente'), false);
  });

  test('sem localStorage: as datas de hoje são refeitas no próprio aparelho (sem reabrir, nada do que foi digitado se perde)', async () => {
    const relogio = { agora: NOITE_MS };
    const s = servidor(NOITE);
    const p = await abrir({ servidor: s, relogio: relogio, semStorage: true });
    digitar(p, 'item-2-preco', '35');
    clicar(p, 'item-2-base-unidade');
    clicar(p, 'gerais-pag-pix');
    relogio.agora += 10.5 * HORA;
    voltarAba(p);
    assert.equal(aberturas(s), 1, 'sem o rascunho no aparelho, reabrir perderia o que só está na tela');
    assert.deepEqual(rotulosValidade(p), DA_TERCA);
    assert.equal(id(p, 'gerais-val-data').getAttribute('min'), '2026-10-20');
    assert.equal(id(p, 'gerais-val-data').getAttribute('max'), '2027-10-21');
    assert.equal(id(p, 'item-2-preco').value, '35');
    assert.ok(ligado(p, 'gerais-pag-pix'));
    primeiroBotaoValidade(p).click();
    await p.C.enviar();
    const c = s.ultimoEnvio();
    assert.equal(c.p_gerais.validade, '2026-10-20');
    assert.deepEqual(c.p_itens.map((x) => x.numero), [2]);
  });

  test('sem localStorage e sem voltar à aba: "hoje 19/10" tocado na tela velha não sai; o preço vai e a validade pede nova escolha', async () => {
    const relogio = { agora: NOITE_MS };
    const s = servidor(NOITE);
    const p = await abrir({ servidor: s, relogio: relogio, semStorage: true });
    relogio.agora += 10.5 * HORA;
    digitar(p, 'item-2-preco', '35');
    clicar(p, 'item-2-base-unidade');
    clicar(p, 'gerais-pag-pix');
    clicar(p, 'gerais-val-2026-10-19');
    await p.C.enviar();
    assert.equal(s.responderes().length, 1);
    const c = s.ultimoEnvio();
    assert.equal(c.p_gerais, null, 'as condições com a data de ontem ficam na tela');
    assert.deepEqual(c.p_itens.map((x) => x.numero), [2]);
    assert.deepEqual(rotulosValidade(p), DA_TERCA);
    assert.equal(erroGerais(p).textContent, PASSOU);
    assert.equal(texto(p, 'mensagem'), 'Falta completar as condições.');
    assert.equal(texto(p, 'gerais-situacao'), 'Ainda não enviado');
  });

  test('aba à vista na virada da meia-noite: o relógio de 15 s troca só as datas (não reabre no meio da digitação)', async () => {
    const relogio = { agora: NOITE_MS };
    const s = servidor(NOITE);
    const p = await abrir({ servidor: s, relogio: relogio });
    Object.defineProperty(p.doc, 'hidden', { configurable: true, get: () => false });
    digitar(p, 'item-2-preco', '3');
    relogio.agora += 3 * HORA;   // ter 0h30
    p.C.atualizarRelogio();
    assert.equal(aberturas(s), 1);
    assert.deepEqual(rotulosValidade(p), DA_TERCA);
    assert.equal(id(p, 'item-2-preco').value, '3');
    assert.equal(erroGerais(p).hidden, true, 'nada escolhido, nada a avisar');
  });

  test('o banco recusa as condições porque o dia virou durante o envio: a tela diz que a validade passou (não o texto genérico)', async () => {
    const relogio = { agora: Date.UTC(2026, 9, 20, 2, 59, 40) };   // seg 19/10 23h59
    const s = servidor({ agora: '2026-10-20T02:59:40.000000Z', agora_local: '2026-10-19 23:59', segundos_para_fechar: 61220 });
    s.interceptar = (nome) => {
      if (nome !== 'cotacao_responder') return undefined;
      relogio.agora += 60 * 1000;   // o banco já está na terça quando o envio chega
      return httpDe({ ok: true, reenvio: false, recebido_em: '2026-10-20T03:00:40.000000Z', itens: [],
        gerais: { resultado: 'erro', rev: 0, valor_atual: A.copia(s.gerais), erro: 'valor_invalido' } });
    };
    const p = await abrir({ servidor: s, relogio: relogio });
    clicar(p, 'gerais-pag-pix');
    clicar(p, 'gerais-val-2026-10-19');
    await p.C.enviar();
    assert.equal(s.ultimoEnvio().p_gerais.validade, '2026-10-19', 'às 23h59 a data ainda era de hoje');
    assert.equal(erroGerais(p).textContent, PASSOU);
    assert.deepEqual(rotulosValidade(p), DA_TERCA, 'as datas já são as de terça');
    assert.equal(texto(p, 'gerais-situacao'), 'Ainda não enviado');
  });

  test('recusa "valor_invalido" com a validade ainda de hoje continua com o texto genérico', async () => {
    const s = servidor();
    s.interceptar = (nome) => (nome === 'cotacao_responder'
      ? httpDe({ ok: true, reenvio: false, recebido_em: s.recebidoEm, itens: [], gerais: { resultado: 'erro', rev: 0, valor_atual: A.copia(s.gerais), erro: 'valor_invalido' } })
      : undefined);
    const p = await abrir({ servidor: s, relogio: { agora: AGORA } });
    clicar(p, 'gerais-val-2026-10-19');
    await p.C.enviar();
    assert.equal(erroGerais(p).textContent, 'Algum valor das condições está fora do esperado. Confira.');
  });

  test('aba fechada à noite e link aberto de novo de manhã: a validade de ontem do rascunho aparece em "outra data" com o aviso', async () => {
    const relogio = { agora: NOITE_MS };
    const s = servidor(NOITE);
    const p1 = await abrir({ servidor: s, relogio: relogio });
    clicar(p1, 'gerais-pag-pix');
    clicar(p1, 'gerais-val-2026-10-19');
    Object.assign(s.abertura, A.copia(MANHA));
    relogio.agora += 10.5 * HORA;
    const p = await abrir({ servidor: s, relogio: relogio, storage: A.storageDe(p1) });
    assert.deepEqual(rotulosValidade(p), DA_TERCA);
    assert.ok(ligado(p, 'gerais-val-outra'));
    assert.equal(id(p, 'gerais-val-data').value, '2026-10-19');
    assert.equal(erroGerais(p).textContent, PASSOU);
    assert.ok(ligado(p, 'gerais-pag-pix'));
  });
});
