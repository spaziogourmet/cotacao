'use strict';
// Funções puras da página: leitura de número, conversão, conta ao vivo, textos, sha256, UUID, endereço,
// rascunho (chaves e limpeza) e montagem do envio. Valores vindos do jsdom passam por JSON (outro "realm").
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const A = require('./ajuda');

const C = A.carregarPuras();
const plano = function (x) { return JSON.parse(JSON.stringify(x)); };

function it(extra) {
  return Object.assign({
    numero: 1, nome: 'ITEM', qtd: 104, unidade: 'un', rotulo: 'un', vende_por_litro: false,
    embalagem: null, fator: null, kg_por_litro: null
  }, extra || {});
}

function form(item, extra) {
  return Object.assign(plano(C.formVazio(item)), extra || {});
}

describe('leitura de número (sem máscara de centavos)', () => {
  test('aceita vírgula, ponto, R$ e milhar como o App', () => {
    assert.equal(C.lerNumero('42'), 42);
    assert.equal(C.lerNumero('42,5'), 42.5);
    assert.equal(C.lerNumero('42.50'), 42.5);
    assert.equal(C.lerNumero('R$ 1.234,50'), 1234.5);
    assert.equal(C.lerNumero('2.79'), 2.79);
    assert.equal(C.lerNumero('1.250'), 1250);
    assert.equal(C.lerNumero('0.500'), 0.5);
    assert.equal(C.lerNumero(' 31,50 '), 31.5);
  });
  test('vazio, negativo e lixo → null', () => {
    for (const t of ['', '   ', 'abc', '-3', '1,2,3', '4,', ',5x', null, undefined]) assert.equal(C.lerNumero(t), null, String(t));
  });
  test('dinheiro: > 0, ≤ 1.000.000 e no máximo 2 casas', () => {
    assert.equal(C.lerDinheiro('42,55'), 42.55);
    assert.equal(C.lerDinheiro('1.000.000'), 1000000);
    assert.equal(C.lerDinheiro('42,555'), null);
    assert.equal(C.lerDinheiro('0'), null);
    assert.equal(C.lerDinheiro('1.000.000,01'), null);
  });
  test('formatação brasileira sem Intl', () => {
    assert.equal(C.formatarReais(1707), 'R$ 1.707,00');
    assert.equal(C.formatarReais(0.42), 'R$ 0,42');
    assert.equal(C.formatarQtd(1.2), '1,2');
    assert.equal(C.formatarQtd(19.9), '19,9');
    assert.equal(C.formatarQtd(1000), '1.000');
  });
});

describe('conversão (espelho do contrato 3.10)', () => {
  const e = function (x) { return Object.assign({ estado: 'tem', emb_unidades: null, emb_gramas: null, emb_ml: null }, x); };
  test('R$ 31,50 fardo c/6 → 5,2500 a un', () => {
    assert.deepEqual(plano(C.converter(it(), e({ preco: 31.5, base: 'embalagem', emb_unidades: 6 }))), { convertido: 5.25, porLitro: null });
  });
  test('R$ 12,40 pacote de 400 g → 31,0000 o kg', () => {
    assert.deepEqual(plano(C.converter(it({ unidade: 'kg', rotulo: 'kg' }), e({ preco: 12.4, base: 'embalagem', emb_gramas: 400 }))), { convertido: 31, porLitro: null });
  });
  test('por litro sem kg_por_litro confirmado → sem conversão', () => {
    const leite = it({ unidade: 'kg', rotulo: 'kg', vende_por_litro: true });
    assert.deepEqual(plano(C.converter(leite, e({ preco: 8, base: 'litro' }))), { convertido: null, porLitro: 8 });
    assert.deepEqual(plano(C.converter(leite, e({ preco: 8, base: 'embalagem', emb_ml: 1000 }))), { convertido: null, porLitro: 8 });
  });
  test('com kg_por_litro confirmado → R$ por kg', () => {
    const leite = it({ unidade: 'kg', rotulo: 'kg', vende_por_litro: true, kg_por_litro: 1 });
    assert.deepEqual(plano(C.converter(leite, e({ preco: 8, base: 'litro' }))), { convertido: 8, porLitro: 8 });
    const oleo = it({ unidade: 'kg', rotulo: 'kg', kg_por_litro: 0.9 });
    assert.equal(C.converter(oleo, e({ preco: 9, base: 'embalagem', emb_ml: 900 })).convertido, 11.1111);
  });
  test('base incompatível → null', () => {
    assert.equal(C.converter(it(), e({ preco: 10, base: 'kg' })), null);
    assert.equal(C.converter(it({ unidade: 'kg' }), e({ preco: 10, base: 'un' })), null);
  });
});

describe('conta ao vivo', () => {
  test('embalagem de un: "R$ 31,50 … c/6 = R$ 5,25 a un · 18 … (108 un) = R$ 567,00"', () => {
    const i = it();
    assert.equal(C.contaAoVivo(i, form(i, { preco: '31,50', base: 'embalagem', emb: '6' })),
      'R$ 31,50 a embalagem c/6 = R$ 5,25 a un · 18 embalagens (108 un) = R$ 567,00');
    const comFardo = it({ embalagem: 'fardo', fator: 6 });
    assert.equal(C.contaAoVivo(comFardo, form(comFardo, { preco: '31,50' })),
      'R$ 31,50 o fardo c/6 = R$ 5,25 a un · 18 fardos (108 un) = R$ 567,00');
  });
  test('kg: "R$ 31,00/kg × 1,2 kg = R$ 37,20"', () => {
    const i = it({ qtd: 1.2, unidade: 'kg', rotulo: 'kg' });
    assert.equal(C.contaAoVivo(i, form(i, { preco: '31', base: 'unidade' })), 'R$ 31,00/kg × 1,2 kg = R$ 37,20');
    assert.equal(C.contaAoVivo(i, form(i, { preco: '12,40', base: 'embalagem', emb: '400' })),
      'R$ 12,40 a embalagem de 400 g = R$ 31,00/kg × 1,2 kg = R$ 37,20');
  });
  test('litro sem fator: só "R$ X o litro"', () => {
    const i = it({ qtd: 19.9, unidade: 'kg', rotulo: 'kg', vende_por_litro: true });
    assert.equal(C.contaAoVivo(i, form(i, { preco: '8', base: 'unidade' })), 'R$ 8,00 o litro');
    assert.equal(C.contaAoVivo(i, form(i, { preco: '8', base: 'embalagem', emb: '1000' })), 'R$ 8,00 a embalagem de 1.000 ml = R$ 8,00 o litro');
  });
  test('litro com kg_por_litro confirmado: vai até o total', () => {
    const i = it({ qtd: 19.9, unidade: 'kg', rotulo: 'kg', vende_por_litro: true, kg_por_litro: 1 });
    assert.equal(C.contaAoVivo(i, form(i, { preco: '8', base: 'unidade' })), 'R$ 8,00 o litro = R$ 8,00/kg × 19,9 kg = R$ 159,20');
  });
  test('rótulo saco', () => {
    const i = it({ qtd: 3, rotulo: 'saco' });
    assert.equal(C.contaAoVivo(i, form(i, { preco: '10', base: 'unidade' })), 'R$ 10,00 o saco × 3 sacos = R$ 30,00');
    assert.equal(C.contaAoVivo(i, form(i, { preco: '90', base: 'embalagem', emb: '10' })), 'R$ 90,00 o fardo c/10 = R$ 9,00 o saco · 1 fardo (10 sacos) = R$ 90,00');
  });
  test('sem base, sem preço ou "não tenho" → nada', () => {
    const i = it();
    assert.equal(C.contaAoVivo(i, form(i, { preco: '10' })), null);
    assert.equal(C.contaAoVivo(i, form(i, { base: 'unidade' })), null);
    assert.equal(C.contaAoVivo(i, form(i, { preco: '10', base: 'unidade', nao_tem: true })), null);
  });
});

describe('quantidade com rótulo', () => {
  test('un, fator confirmado, saco, kg e líquido', () => {
    assert.equal(C.textoQuantidade(it()), '104 un');
    assert.equal(C.textoQuantidade(it({ embalagem: 'fardo', fator: 12 })), '104 un → 9 fardos c/12 (108 un)');
    assert.equal(C.textoQuantidade(it({ qtd: 3, rotulo: 'saco' })), '3 sacos');
    assert.equal(C.textoQuantidade(it({ qtd: 1, rotulo: 'saco' })), '1 saco');
    assert.equal(C.textoQuantidade(it({ qtd: 3, rotulo: 'saco', embalagem: 'fardo', fator: 10 })), '3 sacos → 1 fardo c/10 (10 sacos)');
    assert.equal(C.textoQuantidade(it({ qtd: 1.2, unidade: 'kg', rotulo: 'kg' })), '1,2 kg — cote o kg ou a sua embalagem e diga o peso');
    assert.equal(C.textoQuantidade(it({ qtd: 1.2, unidade: 'kg', rotulo: 'kg', embalagem: 'pacote', fator: 0.5 })), '1,2 kg → 3 pacotes de 500 g (1,5 kg)');
    assert.equal(C.textoQuantidade(it({ qtd: 19.9, unidade: 'kg', rotulo: 'kg', vende_por_litro: true })), '19,9 kg no nosso sistema — cote o litro ou a caixa e diga os ml');
  });
});

describe('textos fixos do cartão e das condições', () => {
  test('"Na última nota" só com o que o banco mandou', () => {
    assert.equal(C.textoUltimaNota(it({ descricao_fornecedor: 'AGUA MIN 500ML', codigo_fornecedor: '7890001' })), 'Na última nota: AGUA MIN 500ML (cód. 7890001)');
    assert.equal(C.textoUltimaNota(it({ descricao_fornecedor: 'AGUA MIN 500ML' })), 'Na última nota: AGUA MIN 500ML');
    assert.equal(C.textoUltimaNota(it()), null);
  });
  test('horário de recebimento vem do config.js; ausente → sem linha', () => {
    assert.equal(C.textoRecebimento(), 'A Spazio recebe mercadoria: seg a sex, 7h–11h e 14h–18h; sáb, 7h–11h e 14h–16h');
    const semHorario = A.carregarPuras({ config: A.CONFIG_TESTE });
    assert.equal(semHorario.textoRecebimento(), null);
  });
});

describe('avisos ao vendedor (texto montado na página)', () => {
  test('centavos, valor_alto e fator_diferente', () => {
    assert.equal(C.textoAviso('centavos', it({ unidade: 'kg' }), { preco_digitado: 0.42 }), 'R$ 0,42 — é isso mesmo? (não seria R$ 42,00?)');
    assert.equal(C.textoAviso('valor_alto', it({ unidade: 'kg' }), { preco_digitado: 1707, preco_convertido: 1707, base: 'kg' }),
      'R$ 1.707,00 por 1 kg — confere? Não é o total da linha?');
    assert.equal(C.textoAviso('valor_alto', it(), { preco_digitado: 400, preco_convertido: 400, base: 'un' }),
      'R$ 400,00 por 1 un — confere? Não é o total da linha?');
    assert.equal(C.textoAviso('valor_alto', it({ unidade: 'kg', vende_por_litro: true }), { preco_digitado: 350, preco_convertido: null, base: 'litro' }),
      'R$ 350,00 por 1 L — confere? Não é o total da linha?');
    assert.equal(C.textoAviso('fator_diferente', it({ embalagem: 'fardo', fator: 12 }), {}), 'O fardo não é de 12?');
    assert.equal(C.textoAviso('fator_diferente', it({ unidade: 'kg', embalagem: 'pacote', fator: 0.5 }), {}), 'O pacote não é de 500 g?');
  });
});

describe('sha256 próprio (sem crypto.subtle)', () => {
  test('igual ao do Node, inclusive nos limites de bloco e com acento/emoji', () => {
    const casos = ['', 'abc', A.CODIGO, 'ção😀', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(63), 'x'.repeat(64), 'x'.repeat(1000)];
    for (const t of casos) assert.equal(C.sha256hex(t), crypto.createHash('sha256').update(t, 'utf8').digest('hex'), JSON.stringify(t).slice(0, 20));
  });
});

describe('UUID do envio', () => {
  const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  test('v4 com crypto.getRandomValues, sem repetir', () => {
    const vistos = new Set();
    for (let i = 0; i < 200; i++) {
      const u = C.novoUuid();
      assert.match(u, V4);
      vistos.add(u);
    }
    assert.equal(vistos.size, 200);
  });
  test('sem crypto (navegador antigo) continua gerando v4', () => {
    const semCrypto = A.carregarPuras({ semCrypto: true });
    assert.match(semCrypto.novoUuid(), V4);
  });
});

describe('endereço: só o "#"', () => {
  test('c, p=1 e de; parâmetros desconhecidos ignorados', () => {
    assert.deepEqual(plano(C.lerHash('#c=' + A.CODIGO)), { c: A.CODIGO, p: false, de: null });
    assert.deepEqual(plano(C.lerHash('#c=' + A.CODIGO + '&p=1')), { c: A.CODIGO, p: true, de: null });
    assert.deepEqual(plano(C.lerHash('#c=' + A.CODIGO + '&de=0123456789abcdef&x=9')), { c: A.CODIGO, p: false, de: '0123456789abcdef' });
    assert.deepEqual(plano(C.lerHash('')), { c: null, p: false, de: null });
  });
});

describe('rascunho no aparelho', () => {
  test('chaves por cotação (hash do código) e por número', () => {
    const h = A.hDe(C, A.CODIGO);
    assert.match(h, /^[0-9a-f]{16}$/);
    assert.equal(C.chaveItem(h, 3), 'cot:' + h + ':3');
    assert.equal(C.chaveGerais(h), 'cot:' + h + ':gerais');
    assert.equal(C.chaveEnvio(h), 'cot:' + h + ':envio');
    assert.notEqual(A.hDe(C, A.CODIGO_VELHO), h);
  });
  test('descarta rascunho com mais de 14 dias e o ilegível; não mexe em outras chaves', () => {
    const agora = Date.UTC(2026, 9, 19, 19, 0);
    const dia = 86400000;
    const dados = new Map([
      ['cot:aaaaaaaaaaaaaaaa:1', JSON.stringify({ t: agora - 15 * dia, rev: 0, v: {} })],
      ['cot:aaaaaaaaaaaaaaaa:2', JSON.stringify({ t: agora - 13 * dia, rev: 0, v: {} })],
      ['cot:aaaaaaaaaaaaaaaa:3', '{quebrado'],
      ['outra:chave', 'fica']
    ]);
    const s = {
      get length() { return dados.size; },
      key: function (i) { return Array.from(dados.keys())[i]; },
      getItem: function (k) { return dados.has(k) ? dados.get(k) : null; },
      setItem: function (k, v) { dados.set(k, String(v)); },
      removeItem: function (k) { dados.delete(k); }
    };
    C.limparRascunhosVelhos(s, agora);
    assert.deepEqual(Array.from(dados.keys()).sort(), ['cot:aaaaaaaaaaaaaaaa:2', 'outra:chave']);
  });
});

describe('formulário ↔ entrada', () => {
  const kg = it({ qtd: 1.2, unidade: 'kg', rotulo: 'kg' });
  test('em branco = sem_resposta; fator confirmado já vem marcado (e sem fator nada é sugerido)', () => {
    assert.equal(C.entradaDoForm(it(), form(it())).entrada.estado, 'sem_resposta');
    const f = plano(C.formVazio(it({ embalagem: 'fardo', fator: 12 })));
    assert.equal(f.base, 'embalagem');
    assert.equal(f.emb, '12');
    const g = plano(C.formVazio(kg));
    assert.equal(g.base, null);
    assert.equal(g.emb, '');
  });
  test('erros locais antes de mandar', () => {
    const e = function (i, x) { const r = C.entradaDoForm(i, form(i, x)); return r.erro && r.erro.codigo; };
    assert.equal(e(it(), { tenho_so: '10' }), 'sem_preco');
    assert.equal(e(it(), { preco: '10' }), 'sem_base');
    assert.equal(e(it(), { preco: '10', base: 'embalagem' }), 'sem_embalagem');
    assert.equal(e(it(), { preco: '10', base: 'embalagem', emb: '2,5' }), 'valor_invalido');
    assert.equal(e(it(), { preco: '10', base: 'embalagem', emb: '10001' }), 'valor_invalido');
    assert.equal(e(kg, { preco: '10', base: 'embalagem', emb: '0,5' }), 'valor_invalido');
    assert.equal(e(it(), { preco: '10,555', base: 'unidade' }), 'valor_invalido');
    assert.equal(e(it(), { preco: '10', base: 'unidade', tenho_so: '-1' }), 'valor_invalido');
    assert.equal(e(it(), { nao_tem: true, similar_desc: 'x'.repeat(201) }), 'texto_invalido');
  });
  test('não tenho leva só o similar', () => {
    const r = C.entradaDoForm(it(), form(it(), { nao_tem: true, preco: '10', base: 'unidade', similar_desc: 'Marca B', similar_preco: '9,90' }));
    assert.deepEqual(plano(r.entrada), {
      estado: 'nao_tem', preco: null, base: null, emb_unidades: null, emb_gramas: null, emb_ml: null,
      tenho_so: null, similar_desc: 'Marca B', similar_preco: 9.9, a_partir_de: null, marca: null, confirmado: false
    });
  });
  test('marca: só com "tem", até 60 caracteres, sem caractere de controle; sozinha pede o preço', () => {
    const e = function (x) { return C.entradaDoForm(it(), form(it(), x)); };
    assert.equal(e({ preco: '10', base: 'unidade', marca: '  Marca A  ' }).entrada.marca, 'Marca A');
    assert.equal(e({ preco: '10', base: 'unidade', marca: '   ' }).entrada.marca, null);
    assert.equal(e({ nao_tem: true, marca: 'Marca A' }).entrada.marca, null);
    assert.equal(e({ preco: '10', base: 'unidade', marca: 'x'.repeat(60) }).entrada.marca, 'x'.repeat(60));
    assert.deepEqual(plano(e({ preco: '10', base: 'unidade', marca: 'x'.repeat(61) }).erro), { codigo: 'texto_invalido', campo: 'marca' });
    assert.deepEqual(plano(e({ preco: '10', base: 'unidade', marca: 'a\u0007b' }).erro), { codigo: 'texto_invalido', campo: 'marca' });
    assert.equal(e({ marca: 'Marca A' }).erro.codigo, 'sem_preco');
  });
  test('marca entra na comparação com a resposta gravada (marca_informada)', () => {
    const r = Object.assign(A.respostaVazia(), { estado: 'tem', preco_digitado: 10, base: 'un', marca_informada: 'Marca A' });
    const f = C.formDaResposta(it(), r);
    assert.equal(f.marca, 'Marca A');
    assert.ok(C.mesmaResposta(C.entradaDoForm(it(), f).entrada, r));
    const outra = Object.assign(plano(f), { marca: 'Marca B' });
    assert.equal(C.mesmaResposta(C.entradaDoForm(it(), outra).entrada, r), false);
    assert.ok(C.mesmaResposta(C.entradaDoForm(it(), outra).entrada, r, true), 'trocar a marca não desfaz o "Está certo"');
  });
  test('ida e volta: resposta gravada → formulário → a mesma entrada', () => {
    const r = A.respostaVazia();
    const casos = [
      [it(), Object.assign({}, r, { estado: 'tem', preco_digitado: 42, base: 'embalagem', emb_unidades: 12, tenho_so: 50 })],
      [kg, Object.assign({}, r, { estado: 'tem', preco_digitado: 12.4, base: 'embalagem', emb_gramas: 400, confirmado_pelo_vendedor: true })],
      [kg, Object.assign({}, r, { estado: 'tem', preco_digitado: 8, base: 'litro' })],
      [it(), Object.assign({}, r, { estado: 'nao_tem', similar_desc: 'Outra marca', similar_preco: 1234.5 })]
    ];
    for (const [i, resp] of casos) {
      const e = C.entradaDoForm(i, C.formDaResposta(i, resp)).entrada;
      assert.ok(C.mesmaResposta(e, resp), JSON.stringify(resp));
    }
  });
});

describe('condições gerais', () => {
  test('formulário → as 6 condições, com a data vinda do banco', () => {
    const f = Object.assign(plano(C.formDosGerais(null, [])), {
      pag: 'boleto', pag_dias: '28', validade: '2026-10-21', minimo: 'sem', frete: '15', entrega: 'seguinte', observacao: 'Entrego até 10h.\nLigar antes.'
    });
    assert.deepEqual(plano(C.geraisDoForm(f, '2026-10-19')), {
      gerais: { pagamento: 'boleto 28 dias', validade: '2026-10-21', pedido_minimo: 0, frete: 15, entrega: 'dia seguinte', observacao: 'Entrego até 10h.\nLigar antes.' },
      erro: null
    });
  });
  test('validade fora de [hoje, hoje + 366] e caractere de controle → erro', () => {
    const base = plano(C.formDosGerais(null, []));
    assert.equal(C.geraisDoForm(Object.assign({}, base, { validade: '2026-10-18' }), '2026-10-19').erro.campo, 'validade');
    assert.equal(C.geraisDoForm(Object.assign({}, base, { validade: '2027-10-21' }), '2026-10-19').erro.campo, 'validade');
    assert.equal(C.geraisDoForm(Object.assign({}, base, { observacao: 'a\u0007b' }), '2026-10-19').erro.campo, 'observacao');
  });
  test('texto que não é opção (ex.: digitado pelo Ivan) volta igual', () => {
    const g = { pagamento: 'boleto 28/35', validade: '2026-11-30', pedido_minimo: 150, frete: null, entrega: 'sexta de manhã', observacao: null };
    const f = C.formDosGerais(g, [{ data: '2026-10-19', rotulo: 'hoje 19/10' }]);
    assert.ok(C.mesmosGerais(C.geraisDoForm(f, '2026-10-19').gerais, g));
  });
  test('data digitada à mão (navegador sem calendário)', () => {
    assert.equal(C.lerDataDigitada('23/10', '2026-10-19'), '2026-10-23');
    assert.equal(C.lerDataDigitada('05/01', '2026-10-19'), '2027-01-05');
    assert.equal(C.lerDataDigitada('2026-10-30', '2026-10-19'), '2026-10-30');
    assert.equal(C.lerDataDigitada('31/02', '2026-10-19'), null);
  });
});

describe('montagem do envio: só o que mudou, cada item com o seu rev', () => {
  test('itens com rascunho; conflito à espera e item inválido ficam de fora; sem_resposta só com 3 chaves', () => {
    const i1 = it({ numero: 1 });
    const i2 = it({ numero: 2 });
    const i3 = it({ numero: 3 });
    const i4 = it({ numero: 4 });
    const i5 = it({ numero: 5 });
    const itens = [
      { item: i1, form: form(i1, { preco: '5,25', base: 'unidade' }), rascunho: { rev: 2 }, conflito: false },
      { item: i2, form: form(i2, { preco: '9' }), rascunho: null, conflito: false },
      { item: i3, form: form(i3, { preco: '7', base: 'unidade' }), rascunho: { rev: 0 }, conflito: true },
      { item: i4, form: form(i4, { preco: '7' }), rascunho: { rev: 0 }, conflito: false },
      { item: i5, form: form(i5), rascunho: { rev: 3 }, conflito: false }
    ];
    const m = plano(C.montarEnvio(itens, null));
    assert.deepEqual(m.numeros, [1, 5]);
    assert.deepEqual(m.invalidos, [4]);
    assert.equal(m.p_gerais, null);
    assert.deepEqual(m.p_itens[0], {
      numero: 1, rev_lida: 2, estado: 'tem', preco: 5.25, base: 'un', emb_unidades: null, emb_gramas: null, emb_ml: null,
      tenho_so: null, similar_desc: null, similar_preco: null, a_partir_de: null, marca: null, confirmado: false
    });
    assert.deepEqual(m.p_itens[1], { numero: 5, rev_lida: 3, estado: 'sem_resposta' });
  });
  test('marca vai com "tem" e nunca com "não tenho"', () => {
    const i1 = it({ numero: 1 });
    const i2 = it({ numero: 2 });
    const itens = [
      { item: i1, form: form(i1, { preco: '10', base: 'unidade', marca: 'Marca A' }), rascunho: { rev: 0 }, conflito: false },
      { item: i2, form: form(i2, { nao_tem: true, marca: 'Marca A' }), rascunho: { rev: 0 }, conflito: false }
    ];
    const m = plano(C.montarEnvio(itens, null));
    assert.equal(m.p_itens[0].marca, 'Marca A');
    assert.deepEqual(m.p_itens[1], { numero: 2, rev_lida: 0, estado: 'nao_tem', similar_desc: null, similar_preco: null });
  });
});

describe('prazo pelo relógio do banco', () => {
  const d = A.abertura();
  test('antes do prazo, depois do prazo e fechada', () => {
    assert.equal(C.textoPrazo(d, 89400), 'Responder até terça, 20/10, 12h');
    assert.equal(C.textoPrazo(d, 18000 - 1), 'O prazo era 12h, mas ainda dá para enviar até 17h de hoje');
    assert.equal(C.textoPrazo(d, 0), 'Cotação encerrada às 17h de ter 20/10. Obrigado!');
  });
  test('"Recebido às …" em Brasília a partir do UTC do banco', () => {
    assert.equal(C.horaRecebido('2026-10-19T19:12:03.000000Z'), '16h12');
    assert.equal(C.horaRecebido('2026-10-20T02:05:00.000000Z'), '23h05');
    assert.equal(C.horaRecebido('2026-10-20T15:00:00.000000Z'), '12h');
  });
});

describe('datas da validade (espelho do cot_validade_opcoes, para quando o dia vira com a página aberta)', () => {
  const rotulos = (hoje) => plano(C.opcoesValidade(hoje)).map((o) => o.data + ' ' + o.rotulo);
  test('segunda: hoje, amanhã, a primeira quarta e a primeira sexta depois de hoje (o exemplo do contrato 5.1)', () => {
    assert.deepEqual(plano(C.opcoesValidade('2026-10-19')), A.abertura().validade_opcoes);
  });
  test('sem repetir a data (fica o primeiro rótulo), em ordem de data', () => {
    assert.deepEqual(rotulos('2026-10-20'), ['2026-10-20 hoje 20/10', '2026-10-21 amanhã 21/10', '2026-10-23 sex 23/10']);
    assert.deepEqual(rotulos('2026-10-22'), ['2026-10-22 hoje 22/10', '2026-10-23 amanhã 23/10', '2026-10-28 qua 28/10']);
    assert.deepEqual(rotulos('2026-10-23'), ['2026-10-23 hoje 23/10', '2026-10-24 amanhã 24/10', '2026-10-28 qua 28/10', '2026-10-30 sex 30/10']);
    assert.deepEqual(rotulos('2026-10-27'), ['2026-10-27 hoje 27/10', '2026-10-28 amanhã 28/10', '2026-10-30 sex 30/10']);
  });
  test('virada de ano e data inválida', () => {
    assert.deepEqual(rotulos('2026-12-31'), ['2026-12-31 hoje 31/12', '2027-01-01 amanhã 01/01', '2027-01-06 qua 06/01']);
    assert.deepEqual(plano(C.opcoesValidade('2026-02-30')), []);
    assert.deepEqual(plano(C.opcoesValidade(null)), []);
  });
});
