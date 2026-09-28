'use strict';
// O corpo que a página manda ao banco (contrato 5.2) é o mesmo que o teste de integração do App grava no SQL de
// verdade (app-compras-spazio, tests/db/cotacao_integracao.test.ts: temPagina, naoTemPagina e geraisPagina). Os
// itens abaixo são os que o banco devolve no cotacao_abrir daquele teste (semana inventada de 19/10/2026). Se um lado
// mudar o formato, este teste ou o do App quebra.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const A = require('./ajuda');

const C = A.carregarPuras();
const plano = function (x) { return JSON.parse(JSON.stringify(x)); };

const base = { nota: null, rotulo: null, vende_por_litro: false, embalagem: null, fator: null, kg_por_litro: null,
  descricao_fornecedor: null, codigo_fornecedor: null };
const AGUA = Object.assign({}, base, { numero: 1, nome: 'ÁGUA MINERAL 500ML', qtd: 60, unidade: 'un', rotulo: 'un', embalagem: 'fardo', fator: 12,
  descricao_fornecedor: 'AGUA MIN S/GAS 500ML', codigo_fornecedor: '7890001' });
const ACUCAR = Object.assign({}, base, { numero: 3, nome: 'AÇÚCAR CRISTAL', nota: 'cristal, pacote de 1 kg', qtd: 8, unidade: 'kg', rotulo: 'kg' });
const LEITE = Object.assign({}, base, { numero: 4, nome: 'LEITE INTEGRAL', qtd: 20, unidade: 'kg', rotulo: 'kg', vende_por_litro: true, kg_por_litro: 1 });

function form(item, extra) {
  return Object.assign(plano(C.formVazio(item)), extra || {});
}

/** Item "tem" como o App espera: todas as chaves, as vazias em null. */
function tem(numero, revLida, r) {
  return Object.assign({
    numero: numero, rev_lida: revLida, estado: 'tem', preco: null, base: null, emb_unidades: null, emb_gramas: null, emb_ml: null,
    tenho_so: null, similar_desc: null, similar_preco: null, a_partir_de: null, marca: null, confirmado: false
  }, r);
}

describe('corpo do cotacao_responder = o do teste de integração do App', () => {
  test('primeiro envio: fardo c/12 já marcado + marca, "não tenho", leite pelo litro e as condições', () => {
    const itens = [
      { item: AGUA, form: form(AGUA, { preco: '31,50', marca: 'Marca A' }), rascunho: { rev: 0 }, conflito: false },
      { item: ACUCAR, form: form(ACUCAR, { nao_tem: true }), rascunho: { rev: 0 }, conflito: false },
      { item: LEITE, form: form(LEITE, { preco: '6,20', base: 'unidade' }), rascunho: { rev: 0 }, conflito: false }
    ];
    const gerais = {
      rascunho: { rev: 0 }, conflito: false, hoje: '2026-10-19',
      form: Object.assign(plano(C.formDosGerais(null, [])), {
        pag: 'boleto', pag_dias: '28', validade: '2026-10-21', minimo: 'sem', frete: '15,00', entrega: 'seguinte',
        observacao: 'Entrego até 10h.'
      })
    };
    const m = plano(C.montarEnvio(itens, gerais));
    assert.deepEqual(m.invalidos, []);
    assert.equal(m.geraisInvalidas, false);
    assert.deepEqual(m.p_itens, [
      tem(1, 0, { preco: 31.5, base: 'embalagem', emb_unidades: 12, marca: 'Marca A' }),
      { numero: 3, rev_lida: 0, estado: 'nao_tem', similar_desc: null, similar_preco: null },
      tem(4, 0, { preco: 6.2, base: 'litro' })
    ]);
    assert.deepEqual(m.p_gerais, {
      rev_lida: 0, pagamento: 'boleto 28 dias', validade: '2026-10-21', pedido_minimo: 0, frete: 15, entrega: 'dia seguinte',
      observacao: 'Entrego até 10h.'
    });
  });

  test('segundo envio: o rev devolvido pelo banco vira o rev_lida; só o item alterado vai', () => {
    const itens = [
      { item: AGUA, form: form(AGUA, { preco: '31,50', marca: 'Marca B' }), rascunho: { rev: 1 }, conflito: false },
      { item: ACUCAR, form: form(ACUCAR, { nao_tem: true }), rascunho: null, conflito: false },
      { item: LEITE, form: form(LEITE, { preco: '6,20', base: 'unidade' }), rascunho: null, conflito: false }
    ];
    const m = plano(C.montarEnvio(itens, { rascunho: null, conflito: false, hoje: '2026-10-19', form: plano(C.formDosGerais(null, [])) }));
    assert.deepEqual(m.p_itens, [tem(1, 1, { preco: 31.5, base: 'embalagem', emb_unidades: 12, marca: 'Marca B' })]);
    assert.equal(m.p_gerais, null);
  });
});
