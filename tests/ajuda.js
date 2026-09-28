'use strict';
// Auxiliares dos testes da página do vendedor (Node + jsdom, fetch simulado). Dados 100% inventados.
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const RAIZ = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(RAIZ, 'app.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(RAIZ, 'index.html'), 'utf8');
const CONFIG_REAL = fs.readFileSync(path.join(RAIZ, 'config.js'), 'utf8');
// config de teste sem RECEBIMENTO (a linha do horário não aparece); a outra é o config.js de verdade com a URL e a
// chave de teste no lugar dos marcadores (a linha do horário usa o RECEBIMENTO do próprio config.js)
const CONFIG_TESTE = "window.COTACAO_CONFIG = { SUPABASE_URL: 'https://teste.supabase.co/', SUPABASE_ANON_KEY: 'sb_publishable_teste' }";
const CONFIG_PUBLICADO = CONFIG_REAL
  .replace('__SUPABASE_URL__', 'https://teste.supabase.co')
  .replace('__SUPABASE_ANON_KEY__', 'sb_publishable_teste');

// códigos inventados no formato do banco (32 caracteres base64url)
const CODIGO = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const CODIGO_2 = 'ZyXwVuTsRqPoNmLkJiHgFeDcBa_-9876';
const CODIGO_VELHO = 'semanaPassada0123456789abcdefghi';
const BASE_URL = 'https://spaziogourmet.github.io/cotacao/';

/** index.html com config.js e app.js embutidos (a substituição por função evita os "$" do código). */
function htmlCom(config) {
  return INDEX
    .replace('<script src="config.js"></script>', function () { return '<script>' + config + '</script>'; })
    .replace('<script src="app.js"></script>', function () { return '<script>' + APP + '</script>'; });
}

function respostaVazia() {
  return {
    estado: 'sem_resposta', preco_digitado: null, base: null, emb_unidades: null, emb_gramas: null, emb_ml: null,
    preco_convertido: null, tenho_so: null, similar_desc: null, similar_preco: null, a_partir_de: null,
    marca_informada: null, confirmado_pelo_vendedor: false, avisos_vendedor: []
  };
}

function item(numero, nome, qtd, unidade, extra) {
  return Object.assign({
    numero: numero, nome: nome, nota: null, qtd: qtd, unidade: unidade, rotulo: unidade, vende_por_litro: false,
    embalagem: null, fator: null, kg_por_litro: null, descricao_fornecedor: null, codigo_fornecedor: null,
    resposta: respostaVazia(), rev: 0
  }, extra || {});
}

/** Retorno de cotacao_abrir no formato do contrato 5.1 (seg 19/10 16h10; prazo ter 20/10 12h; fecha 17h). */
function abertura(extra) {
  return Object.assign({
    ok: true, estado: 'aberta', texto: null, loja: 'Spazio Gourmet', vendedor_nome: 'Fulano',
    versao: 1, complementar: false, substitui_versao: null,
    prazo: '2026-10-20T15:00:00.000000Z', fechamento: '2026-10-20T20:00:00.000000Z', agora: '2026-10-19T19:10:00.000000Z',
    prazo_local: '2026-10-20 12:00', fechamento_local: '2026-10-20 17:00', agora_local: '2026-10-19 16:10',
    segundos_para_fechar: 89400,
    validade_opcoes: [
      { data: '2026-10-19', rotulo: 'hoje 19/10' }, { data: '2026-10-20', rotulo: 'amanhã 20/10' },
      { data: '2026-10-21', rotulo: 'qua 21/10' }, { data: '2026-10-23', rotulo: 'sex 23/10' }
    ],
    itens: [
      item(1, 'ÁGUA MINERAL 500ML', 60, 'un', { embalagem: 'fardo', fator: 12, descricao_fornecedor: 'AGUA MIN S/GAS 500ML', codigo_fornecedor: '7890001' }),
      item(2, 'REFRIGERANTE LATA 350ML', 104, 'un'),
      item(3, 'FARINHA DE TRIGO', 1.2, 'kg'),
      item(4, 'LEITE INTEGRAL', 19.9, 'kg', { vende_por_litro: true }),
      item(5, 'GELO', 3, 'un', { rotulo: 'saco' })
    ],
    gerais: { pagamento: null, validade: null, pedido_minimo: null, frete: null, entrega: null, observacao: null },
    gerais_rev: 0,
    nova: null
  }, extra || {});
}

function copia(x) {
  return JSON.parse(JSON.stringify(x));
}

/** Resposta gravada a partir de uma entrada (o suficiente para a página; a conta de verdade é do banco). */
function respostaDe(e, avisos) {
  const r = respostaVazia();
  r.estado = e.estado;
  if (e.estado === 'sem_resposta') return r;
  r.similar_desc = e.similar_desc === undefined ? null : e.similar_desc;
  r.similar_preco = e.similar_preco === undefined ? null : e.similar_preco;
  if (e.estado === 'nao_tem') return r;
  r.preco_digitado = e.preco;
  r.base = e.base;
  r.emb_unidades = e.emb_unidades === undefined ? null : e.emb_unidades;
  r.emb_gramas = e.emb_gramas === undefined ? null : e.emb_gramas;
  r.emb_ml = e.emb_ml === undefined ? null : e.emb_ml;
  r.tenho_so = e.tenho_so === undefined ? null : e.tenho_so;
  r.a_partir_de = e.a_partir_de === undefined ? null : e.a_partir_de;
  r.marca_informada = e.marca === undefined ? null : e.marca;
  r.preco_convertido = e.base === 'embalagem' && e.emb_unidades ? Math.round(e.preco / e.emb_unidades * 10000) / 10000 : e.preco;
  r.confirmado_pelo_vendedor = !!e.confirmado;
  r.avisos_vendedor = e.confirmado ? [] : (avisos || []);
  return r;
}

/**
 * Banco simulado: cotacao_abrir devolve a abertura; cotacao_responder aplica a regra de rev por item
 * (conflito quando rev_lida ≠ rev), guarda o resultado por envio_id (reenvio idempotente) e conta as chamadas.
 */
function servidorFalso(ab) {
  const s = {
    abertura: ab, chamadas: [], envios: {}, revs: {}, respostas: {}, avisos: {},
    geraisRev: ab.gerais_rev || 0, gerais: ab.gerais, recebidoEm: '2026-10-19T19:12:03.000000Z', interceptar: null
  };
  for (const it of ab.itens || []) {
    s.revs[it.numero] = it.rev;
    s.respostas[it.numero] = it.resposta;
  }
  s.abrir = function () { return copia(s.abertura); };
  s.responder = function (corpo) {
    if (s.envios[corpo.p_envio_id]) return Object.assign(copia(s.envios[corpo.p_envio_id]), { reenvio: true });
    const itens = corpo.p_itens.map(function (e) {
      const n = e.numero;
      if (!(n in s.revs)) return { numero: n, resultado: 'erro', rev: null, valor_atual: null, avisos_vendedor: [], erro: 'numero_inexistente' };
      if (e.rev_lida !== s.revs[n]) {
        return { numero: n, resultado: 'conflito', rev: s.revs[n], valor_atual: s.respostas[n], avisos_vendedor: s.respostas[n].avisos_vendedor, erro: null };
      }
      const va = respostaDe(e, s.avisos[n]);
      s.revs[n] += 1;
      s.respostas[n] = va;
      return { numero: n, resultado: 'gravado', rev: s.revs[n], valor_atual: va, avisos_vendedor: va.avisos_vendedor, erro: null };
    });
    let gerais = null;
    if (corpo.p_gerais) {
      if (corpo.p_gerais.rev_lida !== s.geraisRev) {
        gerais = { resultado: 'conflito', rev: s.geraisRev, valor_atual: s.gerais, erro: null };
      } else {
        const g = {};
        for (const k of ['pagamento', 'validade', 'pedido_minimo', 'frete', 'entrega', 'observacao']) g[k] = corpo.p_gerais[k] === undefined ? null : corpo.p_gerais[k];
        s.geraisRev += 1;
        s.gerais = g;
        gerais = { resultado: 'gravado', rev: s.geraisRev, valor_atual: g, erro: null };
      }
    }
    const res = { ok: true, reenvio: false, recebido_em: s.recebidoEm, itens: itens, gerais: gerais };
    s.envios[corpo.p_envio_id] = copia(res);
    return res;
  };
  s.responderes = function () { return s.chamadas.filter(function (c) { return c.nome === 'cotacao_responder'; }); };
  s.ultimoEnvio = function () { const r = s.responderes(); return r.length ? r[r.length - 1].corpo : null; };
  return s;
}

function respostaHttp(status, json) {
  return { status: status, ok: status >= 200 && status < 300, json: function () { return Promise.resolve(copia(json)); } };
}

function fetchFalso(s) {
  return function (url, init) {
    const nome = String(url).split('/rpc/')[1];
    const corpo = JSON.parse(init.body);
    s.chamadas.push({ nome: nome, corpo: corpo, url: String(url), headers: Object.assign({}, init.headers), init: init });
    if (s.interceptar) {
      const r = s.interceptar(nome, corpo, s.chamadas.length);
      if (r !== undefined) return r;
    }
    const json = nome === 'cotacao_abrir' ? s.abrir(corpo) : s.responder(corpo);
    return Promise.resolve(respostaHttp(200, json));
  };
}

/**
 * Abre a página no jsdom. op: { servidor, url, hash, config, storage: {chave: valor}, semStorage, relogio: {agora},
 * semCrypto, rapido, antes(w) }. O relógio da página (setInterval) é trocado por um manual: o teste chama
 * atualizarRelogio. Com rapido, as esperas de "devagar" (3 s, 60 s) viram 1 ms e ficam anotadas em p.esperas;
 * o tempo-limite de 30 s das chamadas continua como está.
 */
function abrirPagina(op) {
  const o = op || {};
  const s = o.servidor || null;
  const url = o.url || (BASE_URL + (o.hash || '#c=' + CODIGO));
  const esperas = [];
  const dom = new JSDOM(htmlCom(o.config || CONFIG_TESTE), {
    url: url,
    runScripts: 'dangerously',
    beforeParse: function (w) {
      w.fetch = s ? fetchFalso(s) : function () { throw new Error('fetch não esperado'); };
      w.setInterval = function () { return 0; };
      w.clearInterval = function () {};
      if (o.relogio) w.Date.now = function () { return o.relogio.agora; };
      if (o.semCrypto) Object.defineProperty(w, 'crypto', { value: undefined, configurable: true });
      if (o.rapido) {
        const original = w.setTimeout;
        w.setTimeout = function (fn, ms) {
          if (ms === 30000) return original(fn, ms);
          esperas.push(ms);
          return original(fn, 1);
        };
      }
      if (o.semStorage) {
        Object.defineProperty(w, 'localStorage', { configurable: true, get: function () { throw new Error('SecurityError: armazenamento bloqueado'); } });
      } else if (o.storage) {
        for (const k of Object.keys(o.storage)) w.localStorage.setItem(k, o.storage[k]);
      }
      if (o.antes) o.antes(w);
    }
  });
  const w = dom.window;
  return { dom: dom, w: w, doc: w.document, s: s, C: w.CotacaoPagina, esperas: esperas };
}

/** Só as funções puras (config com marcadores: a página não chama nada). */
function carregarPuras(op) {
  const p = abrirPagina(Object.assign({ config: CONFIG_REAL }, op || {}));
  return p.w.CotacaoPagina;
}

function esperar(cond, ms) {
  const fim = Date.now() + (ms || 3000);
  return new Promise(function (resolver, rejeitar) {
    (function passo() {
      let ok = false;
      try { ok = !!cond(); } catch (e) { ok = false; }
      if (ok) return resolver();
      if (Date.now() > fim) return rejeitar(new Error('tempo esgotado esperando: ' + cond.toString()));
      setTimeout(passo, 2);
    })();
  });
}

/** Espera a página sair do "Carregando" (formulário ou tela de estado). */
function carregada(p) {
  return esperar(function () { return p.doc.querySelector('.item') || p.doc.querySelector('.estado'); });
}

function digitar(p, campo, texto) {
  campo.value = texto;
  campo.dispatchEvent(new p.w.Event('input', { bubbles: true }));
}

function porId(p, id) {
  const n = p.doc.getElementById(id);
  if (!n) throw new Error('elemento não encontrado: #' + id);
  return n;
}

/** Copia o localStorage de uma página (para "reabrir" em outra). */
function storageDe(p) {
  const r = {};
  const ls = p.w.localStorage;
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    r[k] = ls.getItem(k);
  }
  return r;
}

function hDe(C, codigo) {
  return C.sha256hex(codigo).slice(0, 16);
}

module.exports = {
  RAIZ, APP, INDEX, CONFIG_REAL, CONFIG_TESTE, CONFIG_PUBLICADO, CODIGO, CODIGO_2, CODIGO_VELHO, BASE_URL,
  respostaVazia, item, abertura, copia, respostaDe, servidorFalso, respostaHttp,
  abrirPagina, carregarPuras, esperar, carregada, digitar, porId, storageDe, hDe
};
