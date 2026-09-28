'use strict';
// Condições incompletas ou inválidas nunca travam os preços (achado do teste real de 28/09: o Ivan, no papel do
// vendedor, preencheu os preços, marcou "Boleto" sem os dias e tocou ENVIAR; a tela disse "Falta completar as
// condições." e "AINDA NÃO ENVIADO", e ele só achou o campo dos dias rolando a tela para cima).
// Regra: os itens válidos vão; as condições vão só inteiras e certas; o que falta aparece junto do campo e num aviso
// curto no rodapé que leva até ele. Dados 100% inventados.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const A = require('./ajuda');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WHATS = 'Se não funcionar, responda pelo WhatsApp com o número do item e o preço.';
const AVISO_BOLETO = 'Preços enviados. Falta o prazo do boleto — toque aqui para completar';
const ERRO_BOLETO = 'Falta o prazo do boleto: quantos dias? (ex.: 28)';

const abertas = [];
afterEach(() => {
  while (abertas.length) {
    try { abertas.pop().w.close(); } catch (e) { /* já fechada */ }
  }
});

/** Abre a página anotando cada scrollIntoView (o jsdom não rola; aqui só se sabe para onde a página quis ir). */
async function abrir(op) {
  const o = Object.assign({}, op || {});
  const antes = o.antes;
  o.antes = function (w) {
    w.__rolados = [];
    w.Element.prototype.scrollIntoView = function () { w.__rolados.push(this.id || this.className); };
    if (antes) antes(w);
  };
  const p = A.abrirPagina(o);
  abertas.push(p);
  await A.carregada(p);
  return p;
}

const servidor = (extra) => A.servidorFalso(A.abertura(extra));
const id = (p, x) => A.porId(p, x);
const texto = (p, x) => id(p, x).textContent;
const clicar = (p, x) => id(p, x).click();
const digitar = (p, x, t) => A.digitar(p, id(p, x), t);
const visivel = (p, x) => !id(p, x).hidden;
const ligado = (p, x) => id(p, x).getAttribute('aria-pressed') === 'true';
const h = () => A.hDe(A.carregarPuras(), A.CODIGO);
const ls = (p) => p.w.localStorage;
const rolados = (p) => p.w.__rolados.slice();
const errosVisiveis = (p) => Array.from(p.doc.querySelectorAll('#gerais .erro-item')).filter((n) => !n.hidden).map((n) => n.textContent);
const grupoDe = (p, rotulo) => p.doc.querySelector('[aria-labelledby="' + rotulo + '"]');

/** Os cinco preços da abertura de teste, como o Ivan preencheu no celular. */
function preencherPrecos(p) {
  digitar(p, 'item-1-preco', '31,50');           // fardo c/12 já vem marcado
  digitar(p, 'item-2-preco', '4,20');
  clicar(p, 'item-2-base-unidade');
  digitar(p, 'item-3-preco', '12,40');
  clicar(p, 'item-3-base-unidade');
  digitar(p, 'item-4-preco', '8');
  clicar(p, 'item-4-base-unidade');
  digitar(p, 'item-5-preco', '10');
  clicar(p, 'item-5-base-unidade');
}

/** Toca no botão ENVIAR de verdade e espera a resposta do banco (ou nada sair). */
async function tocarEnviar(p, s, chamadasDepois) {
  clicar(p, 'enviar');
  await A.esperar(() => s.responderes().length === chamadasDepois && texto(p, 'status') !== 'Enviando…');
}

describe('cenário do teste real de 28/09: Boleto marcado e os dias em branco', () => {
  test('os preços vão no primeiro ENVIAR; o aviso diz o que falta, leva ao campo e as condições vão depois de completar', async () => {
    const s = servidor();
    const p = await abrir({ servidor: s });
    preencherPrecos(p);
    clicar(p, 'gerais-pag-boleto');
    assert.equal(id(p, 'gerais-pag-dias').value, '', 'o número de dias ficou vazio');

    await tocarEnviar(p, s, 1);

    // 1) nenhum preço fica preso por causa das condições
    const c1 = s.ultimoEnvio();
    assert.match(c1.p_envio_id, UUID);
    assert.deepEqual(c1.p_itens.map((x) => [x.numero, x.rev_lida, x.preco]), [[1, 0, 31.5], [2, 0, 4.2], [3, 0, 12.4], [4, 0, 8], [5, 0, 10]]);
    assert.equal(c1.p_gerais, null, 'condição incompleta não vai');
    for (const n of [1, 2, 3, 4, 5]) {
      assert.equal(s.respostas[n].estado, 'tem', 'item ' + n + ' gravado no banco');
      assert.equal(texto(p, 'item-' + n + '-situacao'), 'Recebido');
      assert.equal(ls(p).getItem('cot:' + h() + ':' + n), null, 'o item ' + n + ' saiu do rascunho do aparelho');
    }

    // 2) o rodapé não diz mais "Falta completar as condições." nem "AINDA NÃO ENVIADO"
    assert.equal(visivel(p, 'mensagem'), false);
    assert.equal(visivel(p, 'faixa-pendente'), false, 'sem a faixa vermelha: os preços chegaram');
    assert.equal(texto(p, 'status'), 'Recebido às 16h12');
    assert.equal(visivel(p, 'completar'), true);
    assert.equal(texto(p, 'completar'), AVISO_BOLETO);
    assert.equal(id(p, 'completar').tagName, 'BUTTON');
    assert.equal(visivel(p, 'pronto'), false, '"Pronto!" só com as condições resolvidas');

    // 3) o erro aparece junto do campo dos dias (logo abaixo do grupo do pagamento), não no fim do cartão
    const erro = id(p, 'gerais-erro-pagamento');
    assert.equal(erro.hidden, false);
    assert.equal(erro.textContent, ERRO_BOLETO);
    assert.equal(erro.previousElementSibling, grupoDe(p, 'gerais-pag-rotulo'), 'logo depois das opções de pagamento');
    assert.equal(id(p, 'gerais-pag-dias').getAttribute('aria-invalid'), 'true');
    assert.deepEqual(errosVisiveis(p), [ERRO_BOLETO]);
    assert.equal(texto(p, 'gerais-situacao'), 'Ainda não enviado');
    assert.ok(ls(p).getItem('cot:' + h() + ':gerais'), 'as condições continuam guardadas no aparelho');

    // 4) a tela foi até o campo dos dias e o destacou
    assert.equal(rolados(p).pop(), 'gerais-pag-dias');
    assert.ok(grupoDe(p, 'gerais-pag-rotulo').classList.contains('destaque'));

    // 5) o vendedor rolou para outro lado; o toque no aviso volta ao campo e põe o cursor nele
    p.w.__rolados.length = 0;
    clicar(p, 'completar');
    assert.deepEqual(rolados(p), ['gerais-pag-dias']);
    assert.equal(p.doc.activeElement, id(p, 'gerais-pag-dias'));

    // 6) completou: o aviso e o erro somem, e agora sim as condições estão prontas para ir
    digitar(p, 'gerais-pag-dias', '28');
    assert.equal(visivel(p, 'completar'), false);
    assert.equal(id(p, 'gerais-erro-pagamento').hidden, true);
    assert.deepEqual(errosVisiveis(p), []);
    assert.equal(id(p, 'gerais-pag-dias').getAttribute('aria-invalid'), null);
    assert.equal(grupoDe(p, 'gerais-pag-rotulo').classList.contains('destaque'), false);
    assert.ok(visivel(p, 'faixa-pendente'));
    assert.equal(texto(p, 'status'), 'Ainda não enviado.');
    assert.equal(id(p, 'enviar').disabled, false);

    await tocarEnviar(p, s, 2);
    const c2 = s.ultimoEnvio();
    assert.notEqual(c2.p_envio_id, c1.p_envio_id, 'envio novo (o primeiro foi confirmado)');
    assert.deepEqual(c2.p_itens, [], 'os preços não vão de novo');
    assert.deepEqual(c2.p_gerais, {
      rev_lida: 0, pagamento: 'boleto 28 dias', validade: null, pedido_minimo: null, frete: null, entrega: null, observacao: null
    });
    assert.equal(s.gerais.pagamento, 'boleto 28 dias');
    assert.equal(texto(p, 'gerais-situacao'), 'Recebido');
    assert.equal(visivel(p, 'faixa-pendente'), false);
    assert.equal(visivel(p, 'completar'), false);
    assert.equal(texto(p, 'status'), 'Recebido às 16h12');
    assert.equal(visivel(p, 'pronto'), true);
    assert.deepEqual(Object.keys(A.storageDe(p)).filter((k) => k.indexOf('cot:' + h() + ':') === 0), [], 'nada pendente no aparelho');
  });

  test('fechou a aba sem completar: ao reabrir o aviso já aparece e o ENVIAR leva de novo ao campo, sem chamar o banco', async () => {
    const s = servidor();
    const p1 = await abrir({ servidor: s });
    preencherPrecos(p1);
    clicar(p1, 'gerais-pag-boleto');
    await tocarEnviar(p1, s, 1);

    s.abertura.itens.forEach((it) => { it.resposta = A.copia(s.respostas[it.numero]); it.rev = s.revs[it.numero]; });
    const p = await abrir({ servidor: s, storage: A.storageDe(p1) });
    assert.ok(ligado(p, 'gerais-pag-boleto'));
    assert.equal(id(p, 'gerais-pag-dias').value, '');
    assert.equal(texto(p, 'completar'), AVISO_BOLETO);
    assert.equal(texto(p, 'gerais-erro-pagamento'), ERRO_BOLETO);
    assert.equal(visivel(p, 'faixa-pendente'), false);
    assert.equal(id(p, 'enviar').disabled, false);

    p.w.__rolados.length = 0;
    clicar(p, 'enviar');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(s.responderes().length, 1, 'nada a mandar enquanto falta o prazo');
    assert.deepEqual(rolados(p), ['gerais-pag-dias']);
    assert.equal(visivel(p, 'mensagem'), false);
  });

  test('só as condições, sem nenhum preço: nada sai, o aviso não fala em preços e a tela vai ao campo', async () => {
    const s = servidor();
    const p = await abrir({ servidor: s });
    clicar(p, 'gerais-pag-boleto');
    digitar(p, 'gerais-frete', '30');
    await p.C.enviar();
    assert.equal(s.responderes().length, 0);
    assert.equal(texto(p, 'completar'), 'Falta o prazo do boleto — toque aqui para completar');
    assert.equal(texto(p, 'gerais-erro-pagamento'), ERRO_BOLETO);
    assert.equal(rolados(p).pop(), 'gerais-pag-dias');
    assert.equal(visivel(p, 'faixa-pendente'), false);
    assert.equal(texto(p, 'status'), '');
  });

  test('preço de item incompleto continua com a mensagem do item; o aviso das condições vem junto, sem "Preços enviados"', async () => {
    const s = servidor();
    const p = await abrir({ servidor: s });
    digitar(p, 'item-1-preco', '31,50');
    digitar(p, 'item-2-preco', '4,20');     // sem dizer de que é o preço
    clicar(p, 'gerais-pag-boleto');
    await p.C.enviar();
    assert.deepEqual(s.ultimoEnvio().p_itens.map((x) => x.numero), [1], 'o item certo vai');
    assert.equal(s.ultimoEnvio().p_gerais, null);
    assert.equal(texto(p, 'mensagem'), 'Falta completar o item 2.');
    assert.equal(texto(p, 'completar'), 'Falta o prazo do boleto — toque aqui para completar');
    assert.ok(visivel(p, 'faixa-pendente'), 'o item 2 ainda não foi');
    assert.equal(rolados(p).pop(), 'item-2', 'primeiro o que vem antes na tela');
  });
});

describe('qualquer condição incompleta ou inválida: os preços vão, a condição espera junto do campo', () => {
  test('frete que não é número ("grátis"): preços vão, erro junto do frete e o aviso leva até ele', async () => {
    const s = servidor();
    const p = await abrir({ servidor: s });
    digitar(p, 'item-2-preco', '4,20');
    clicar(p, 'item-2-base-unidade');
    clicar(p, 'gerais-pag-pix');
    digitar(p, 'gerais-frete', 'grátis');
    await p.C.enviar();
    assert.deepEqual(s.ultimoEnvio().p_itens.map((x) => x.numero), [2]);
    assert.equal(s.ultimoEnvio().p_gerais, null, 'as condições vão inteiras e certas, ou esperam');
    assert.equal(texto(p, 'completar'), 'Preços enviados. Não entendi o frete — toque aqui para corrigir');
    const erro = id(p, 'gerais-erro-frete');
    assert.equal(erro.textContent, 'Não entendi o frete. Use só números (ex.: 30,00; sem frete: 0).');
    assert.ok(erro.previousElementSibling.contains(id(p, 'gerais-frete')), 'logo abaixo do campo do frete');
    assert.equal(rolados(p).pop(), 'gerais-frete');
    clicar(p, 'completar');
    assert.equal(p.doc.activeElement, id(p, 'gerais-frete'));
    digitar(p, 'gerais-frete', '0');
    await p.C.enviar();
    assert.deepEqual(s.ultimoEnvio().p_itens, []);
    assert.equal(s.ultimoEnvio().p_gerais.pagamento, 'Pix');
    assert.equal(s.ultimoEnvio().p_gerais.frete, 0);
    assert.equal(visivel(p, 'completar'), false);
  });

  test('"Mínimo R$" e "Outra data" da entrega sem o valor: cada erro junto do seu campo; o aviso segue a ordem da tela', async () => {
    const s = servidor();
    const p = await abrir({ servidor: s });
    digitar(p, 'item-2-preco', '4,20');
    clicar(p, 'item-2-base-unidade');
    clicar(p, 'gerais-pag-pix');
    clicar(p, 'gerais-min-valor-bt');
    clicar(p, 'gerais-ent-outra-bt');
    await p.C.enviar();
    assert.deepEqual(s.ultimoEnvio().p_itens.map((x) => x.numero), [2]);
    assert.equal(s.ultimoEnvio().p_gerais, null);
    assert.deepEqual(errosVisiveis(p), [
      'Falta o valor do pedido mínimo (ou toque em Sem mínimo).',
      'Falta dizer quando entrega (ex.: quinta de manhã).'
    ]);
    assert.equal(id(p, 'gerais-erro-minimo').previousElementSibling, grupoDe(p, 'gerais-min-rotulo'));
    assert.equal(id(p, 'gerais-erro-entrega').previousElementSibling, grupoDe(p, 'gerais-ent-rotulo'));
    assert.equal(texto(p, 'completar'), 'Preços enviados. Falta o valor do pedido mínimo — toque aqui para completar');
    assert.equal(rolados(p).pop(), 'gerais-min-valor');

    digitar(p, 'gerais-min-valor', '300');
    assert.equal(texto(p, 'completar'), 'Preços enviados. Falta dizer quando entrega — toque aqui para completar');
    clicar(p, 'completar');
    assert.equal(rolados(p).pop(), 'gerais-ent-outra');
    assert.equal(p.doc.activeElement, id(p, 'gerais-ent-outra'));
    digitar(p, 'gerais-ent-outra', 'quinta de manhã');
    assert.equal(visivel(p, 'completar'), false);
    await p.C.enviar();
    const g = s.ultimoEnvio().p_gerais;
    assert.equal(g.pedido_minimo, 300);
    assert.equal(g.entrega, 'quinta de manhã');
  });

  test('"outra data" da validade sem data: falta a data (antes ia sem validade, em silêncio)', async () => {
    const s = servidor();
    const p = await abrir({ servidor: s });
    digitar(p, 'item-2-preco', '4,20');
    clicar(p, 'item-2-base-unidade');
    clicar(p, 'gerais-val-outra');
    await p.C.enviar();
    assert.equal(s.ultimoEnvio().p_gerais, null);
    assert.equal(texto(p, 'gerais-erro-validade'), 'Falta a data: escolha no calendário ou toque numa das datas.');
    assert.equal(texto(p, 'completar'), 'Preços enviados. Falta a data de validade — toque aqui para completar');
    assert.equal(rolados(p).pop(), 'gerais-val-opcoes', 'o grupo das datas vai para o centro');
    assert.ok(grupoDe(p, 'gerais-val-rotulo').classList.contains('destaque'));
    clicar(p, 'gerais-val-2026-10-23');
    assert.equal(visivel(p, 'completar'), false);
    await p.C.enviar();
    assert.equal(s.ultimoEnvio().p_gerais.validade, '2026-10-23');
  });

  test('dias do boleto fora do esperado ("0"): "o prazo do boleto não está certo", toque para corrigir', async () => {
    const s = servidor();
    const p = await abrir({ servidor: s });
    digitar(p, 'item-2-preco', '4,20');
    clicar(p, 'item-2-base-unidade');
    clicar(p, 'gerais-pag-boleto');
    digitar(p, 'gerais-pag-dias', '0');
    await p.C.enviar();
    assert.equal(s.ultimoEnvio().p_gerais, null);
    assert.equal(texto(p, 'gerais-erro-pagamento'), 'Prazo do boleto: número de dias, de 1 a 365.');
    assert.equal(texto(p, 'completar'), 'Preços enviados. O prazo do boleto não está certo — toque aqui para corrigir');
  });
});

describe('sem quebrar envio_id, rev_lida, "devagar" e rascunho', () => {
  test('sem rede no ENVIAR com o boleto sem dias: a nova tentativa, já com os dias, usa o mesmo envio_id e leva tudo', async () => {
    const s = servidor();
    let cair = true;
    s.interceptar = (nome) => (nome === 'cotacao_responder' && cair ? Promise.reject(new TypeError('sem rede')) : undefined);
    const p = await abrir({ servidor: s });
    digitar(p, 'item-2-preco', '4,20');
    clicar(p, 'item-2-base-unidade');
    clicar(p, 'gerais-pag-boleto');
    await p.C.enviar();
    const c1 = s.ultimoEnvio();
    assert.deepEqual(c1.p_itens.map((x) => x.numero), [2]);
    assert.equal(c1.p_gerais, null);
    assert.ok(visivel(p, 'faixa-pendente'), 'o preço ainda não foi confirmado');
    assert.ok(texto(p, 'status').indexOf('Não consegui confirmar o envio.') >= 0);
    assert.equal(texto(p, 'completar'), 'Falta o prazo do boleto — toque aqui para completar', 'sem "Preços enviados": não foram');
    const pe = JSON.parse(ls(p).getItem('cot:' + h() + ':envio'));
    assert.equal(pe.envio_id, c1.p_envio_id);

    cair = false;
    digitar(p, 'gerais-pag-dias', '28');
    await p.C.enviar();
    const c2 = s.ultimoEnvio();
    assert.equal(c2.p_envio_id, c1.p_envio_id, 'o mesmo envio_id até a confirmação');
    assert.deepEqual(c2.p_itens.map((x) => [x.numero, x.rev_lida]), [[2, 0]]);
    assert.equal(c2.p_gerais.pagamento, 'boleto 28 dias');
    assert.equal(c2.p_gerais.rev_lida, 0);
    assert.equal(visivel(p, 'faixa-pendente'), false);
    assert.equal(visivel(p, 'completar'), false);
    assert.equal(ls(p).getItem('cot:' + h() + ':envio'), null);
  });

  test('resposta perdida: o reenvio confirma os preços e o seguimento manda as condições completadas (rev_lida 0)', async () => {
    const s = servidor();
    s.interceptar = (nome, corpo) => {
      if (nome === 'cotacao_responder' && s.responderes().length === 1) {
        s.responder(corpo);   // o banco gravou o preço, mas a resposta se perdeu
        return Promise.reject(new TypeError('conexão caiu na volta'));
      }
      return undefined;
    };
    const p = await abrir({ servidor: s });
    digitar(p, 'item-2-preco', '4,20');
    clicar(p, 'item-2-base-unidade');
    clicar(p, 'gerais-pag-boleto');
    await p.C.enviar();
    assert.equal(s.revs[2], 1, 'o preço chegou');
    digitar(p, 'gerais-pag-dias', '28');
    await p.C.enviar();
    const r = s.responderes();
    assert.equal(r.length, 3, 'reenvio + seguimento');
    assert.equal(r[1].corpo.p_envio_id, r[0].corpo.p_envio_id, 'reenvio com o mesmo envio_id');
    assert.notEqual(r[2].corpo.p_envio_id, r[0].corpo.p_envio_id, 'o seguimento nasce com envio_id novo');
    assert.deepEqual(r[2].corpo.p_itens, []);
    assert.equal(r[2].corpo.p_gerais.rev_lida, 0);
    assert.equal(r[2].corpo.p_gerais.pagamento, 'boleto 28 dias');
    assert.equal(s.revs[2], 1, 'o preço não foi gravado duas vezes');
    assert.equal(texto(p, 'item-2-situacao'), 'Recebido');
    assert.equal(texto(p, 'gerais-situacao'), 'Recebido');
    assert.equal(visivel(p, 'completar'), false);
  });

  test('"devagar": espera e tenta de novo com o mesmo envio_id; o aviso das condições só aparece com a resposta', async () => {
    const s = servidor();
    s.interceptar = (nome) => (nome === 'cotacao_responder' && s.responderes().length === 1
      ? Promise.resolve(A.respostaHttp(200, { ok: false, erro: 'devagar', texto: 'Aguarde alguns segundos.', espera_s: 3 }))
      : undefined);
    const p = await abrir({ servidor: s, rapido: true });
    digitar(p, 'item-2-preco', '4,20');
    clicar(p, 'item-2-base-unidade');
    clicar(p, 'gerais-pag-boleto');
    await p.C.enviar();
    const r = s.responderes();
    assert.equal(r.length, 2);
    assert.equal(r[1].corpo.p_envio_id, r[0].corpo.p_envio_id);
    assert.equal(r[1].corpo.p_gerais, null);
    assert.equal(s.respostas[2].preco_digitado, 4.2);
    assert.equal(texto(p, 'completar'), AVISO_BOLETO);
    assert.equal(visivel(p, 'faixa-pendente'), false);
  });

  test('conflito nas condições não vira "falta completar": a escolha continua sendo a do conflito', async () => {
    const s = servidor();
    s.geraisRev = 1;
    s.gerais = { pagamento: 'Pix', validade: null, pedido_minimo: null, frete: null, entrega: null, observacao: null };
    const p = await abrir({ servidor: s });
    clicar(p, 'gerais-pag-vista');
    await p.C.enviar();
    assert.equal(p.doc.querySelector('#gerais .conflito').hidden, false);
    assert.equal(visivel(p, 'completar'), false);
    assert.ok(visivel(p, 'faixa-pendente'));
  });

  test('a cotação fechou com o boleto ainda sem os dias: o aviso some, a faixa volta e o ENVIAR diz que ficou no celular', async () => {
    const relogio = { agora: Date.UTC(2026, 9, 19, 19, 10) };
    const s = servidor({ segundos_para_fechar: 60 });
    const p = await abrir({ servidor: s, relogio: relogio });
    digitar(p, 'item-2-preco', '4,20');
    clicar(p, 'item-2-base-unidade');
    clicar(p, 'gerais-pag-boleto');
    await p.C.enviar();
    assert.equal(texto(p, 'completar'), AVISO_BOLETO);
    relogio.agora += 61 * 1000;
    p.C.atualizarRelogio();
    assert.equal(visivel(p, 'completar'), false, 'não há mais o que completar');
    assert.ok(visivel(p, 'faixa-pendente'));
    clicar(p, 'faixa-pendente');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(s.responderes().length, 1);
    assert.equal(texto(p, 'mensagem'), 'A cotação já fechou; o que não foi enviado ficou só neste celular. ' + WHATS);
  });

  test('prévia (&p=1) nunca mostra o aviso nem chama o banco', async () => {
    const s = servidor();
    s.abertura.gerais = { pagamento: 'boleto', validade: null, pedido_minimo: null, frete: null, entrega: null, observacao: null };
    const p = await abrir({ servidor: s, hash: '#c=' + A.CODIGO + '&p=1' });
    assert.equal(visivel(p, 'completar'), false);
    assert.equal(s.responderes().length, 0);
  });
});

describe('funções puras das condições', () => {
  const C = A.carregarPuras();
  const plano = (x) => JSON.parse(JSON.stringify(x));
  const base = () => plano(C.formDosGerais(null, []));
  const erro = (extra) => plano(C.geraisDoForm(Object.assign(base(), extra), '2026-10-19').erro);

  test('opção escolhida sem o valor que ela pede é incompleta; valor fora do esperado é inválido', () => {
    assert.deepEqual(erro({ pag: 'boleto' }), { campo: 'pagamento', motivo: 'sem_dias' });
    assert.deepEqual(erro({ pag: 'boleto', pag_dias: '  ' }), { campo: 'pagamento', motivo: 'sem_dias' });
    assert.deepEqual(erro({ pag: 'boleto', pag_dias: '0' }), { campo: 'pagamento', motivo: 'dias' });
    assert.deepEqual(erro({ pag: 'boleto', pag_dias: '28 dias' }), { campo: 'pagamento', motivo: 'dias' });
    assert.deepEqual(erro({ validade_outra: true }), { campo: 'validade', motivo: 'sem_data' });
    assert.deepEqual(erro({ validade: '2026-10-18' }), { campo: 'validade', motivo: 'passou' });
    assert.deepEqual(erro({ validade: '2027-10-21' }), { campo: 'validade', motivo: 'data' });
    assert.deepEqual(erro({ minimo: 'valor' }), { campo: 'pedido_minimo', motivo: 'sem_valor' });
    assert.deepEqual(erro({ minimo: 'valor', minimo_valor: 'trezentos' }), { campo: 'pedido_minimo', motivo: 'valor' });
    assert.deepEqual(erro({ frete: 'grátis' }), { campo: 'frete', motivo: 'valor' });
    assert.deepEqual(erro({ entrega: 'outra' }), { campo: 'entrega', motivo: 'sem_texto' });
    assert.deepEqual(erro({ observacao: 'a\u0007b' }), { campo: 'observacao', motivo: 'texto' });
    assert.equal(C.geraisDoForm(Object.assign(base(), { pag: 'boleto', pag_dias: '28' }), '2026-10-19').gerais.pagamento, 'boleto 28 dias');
    assert.equal(C.geraisDoForm(Object.assign(base(), { minimo: 'sem' }), '2026-10-19').gerais.pedido_minimo, 0);
  });

  test('"boleto" sem dias gravado antes (ou digitado pelo Ivan) volta igual: não vira pendência sozinho', () => {
    const g = { pagamento: 'boleto', validade: null, pedido_minimo: null, frete: null, entrega: null, observacao: null };
    const f = C.formDosGerais(g, []);
    const x = C.geraisDoForm(f, '2026-10-19');
    assert.equal(x.erro, null);
    assert.ok(C.mesmosGerais(x.gerais, g));
  });

  test('montagem do envio: itens válidos vão mesmo com as condições incompletas', () => {
    const it = { numero: 2, nome: 'ITEM', qtd: 10, unidade: 'un', rotulo: 'un', vende_por_litro: false, embalagem: null, fator: null, kg_por_litro: null };
    const itens = [{ item: it, form: Object.assign(plano(C.formVazio(it)), { preco: '4,20', base: 'unidade' }), rascunho: { rev: 0 }, conflito: false }];
    const gerais = { rascunho: { rev: 0 }, conflito: false, hoje: '2026-10-19', form: Object.assign(base(), { pag: 'boleto' }) };
    const m = plano(C.montarEnvio(itens, gerais));
    assert.deepEqual(m.numeros, [2]);
    assert.equal(m.p_gerais, null);
    assert.equal(m.geraisInvalidas, true);
    assert.deepEqual(m.invalidos, []);
  });
});
