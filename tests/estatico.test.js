'use strict';
// Conferências no texto dos arquivos publicados: ES2017 sem módulos, nada de innerHTML, cabeçalho da página,
// config.js sem chave de serviço e repositório público sem telefone.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const A = require('./ajuda');

const ler = (arq) => fs.readFileSync(path.join(A.RAIZ, arq), 'utf8');

/** Tira comentários e textos entre aspas (o bastante para procurar sintaxe sem falso positivo em texto). */
function soCodigo(js) {
  return js
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

describe('app.js roda no navegador embutido do WhatsApp (ES2017, sem módulos, sem bibliotecas)', () => {
  const codigo = soCodigo(A.APP);
  test('sem sintaxe posterior ao ES2017', () => {
    const proibidos = [
      [/\?\./, 'encadeamento opcional ?.'],
      [/\?\?/, 'coalescência ??'],
      [/\.\.\.\s*[A-Za-z_$[{(]/, 'spread/rest'],
      [/catch\s*\{/, 'catch sem parâmetro'],
      [/\(\?<[=!A-Za-z]/, 'lookbehind ou grupo nomeado em regex'],
      [/`/, 'template string (evitada por clareza)'],
      [/\bclass\s+[A-Z]/, 'class'],
      [/\basync\b|\bawait\b/, 'async/await (ES2017, mas evitado: tudo em promessas)'],
      [/\.(flat|flatMap|matchAll|replaceAll|at)\(/, 'método posterior ao ES2017'],
      [/Object\.fromEntries|globalThis|BigInt|Promise\.(allSettled|any)/, 'API posterior ao ES2017']
    ];
    for (const [re, nome] of proibidos) assert.equal(re.test(codigo), false, nome);
  });
  test('sem módulos, sem innerHTML e sem eval: o texto do banco entra por textContent', () => {
    for (const re of [/\bimport\b/, /\bexport\b/, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, /\beval\(|new Function\(/, /crypto\.subtle/]) {
      assert.equal(re.test(codigo), false, String(re));
    }
    assert.ok(/textContent/.test(codigo));
  });
  test('expõe um único global, window.CotacaoPagina, com iniciar()', () => {
    const w = A.carregarPuras();
    assert.equal(typeof w.iniciar, 'function');
    for (const f of ['lerNumero', 'converter', 'contaAoVivo', 'chaveItem', 'montarEnvio', 'sha256hex', 'novoUuid']) {
      assert.equal(typeof w[f], 'function', f);
    }
  });
});

describe('index.html', () => {
  const html = A.INDEX;
  test('referrer, prévia do link e só os dois scripts, sem módulo', () => {
    assert.ok(html.indexOf('<meta name="referrer" content="no-referrer">') >= 0);
    assert.ok(html.indexOf('<meta property="og:title" content="Cotação — Spazio Gourmet">') >= 0);
    assert.ok(html.indexOf('<meta property="og:image" content="https://spaziogourmet.github.io/cotacao/previa.jpg">') >= 0);
    assert.ok(html.indexOf('<html lang="pt-BR">') >= 0);
    const scripts = html.match(/<script[^>]*>/g);
    assert.deepEqual(scripts, ['<script src="config.js">', '<script src="app.js">']);
    assert.equal(/type="module"/.test(html), false);
  });
});

describe('config.js (público)', () => {
  const cfg = A.CONFIG_REAL;
  test('RECEBIMENTO é o horário aprovado pelo Ivan (o mesmo do App)', () => {
    assert.ok(cfg.indexOf("RECEBIMENTO: 'seg a sex, 7h–11h e 14h–18h; sáb, 7h–11h e 14h–16h'") >= 0);
  });
  test('nunca a chave de serviço: só a anônima (JWT com role anon ou sb_publishable_) ou o marcador', () => {
    const m = /SUPABASE_ANON_KEY:\s*'([^']*)'/.exec(cfg);
    assert.ok(m, 'SUPABASE_ANON_KEY presente');
    const chave = m[1];
    assert.equal(/^sb_secret_/.test(chave), false, 'chave secreta (sb_secret_) não pode ir para a página');
    if (/^eyJ/.test(chave)) {
      const corpo = JSON.parse(Buffer.from(chave.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      assert.equal(corpo.role, 'anon', 'a chave JWT precisa ser a anônima');
    } else {
      assert.ok(chave === '__SUPABASE_ANON_KEY__' || /^sb_publishable_/.test(chave), 'marcador ou chave publicável');
    }
  });
});

describe('repositório público', () => {
  test('nenhum telefone real (55 + DDD + número) nos arquivos da pasta', () => {
    const arquivos = ['index.html', 'app.js', 'config.js', 'estilo.css', 'README.md', 'package.json']
      .concat(fs.readdirSync(path.join(A.RAIZ, 'tests')).map((f) => 'tests/' + f));
    for (const f of arquivos) {
      if (!fs.existsSync(path.join(A.RAIZ, f))) continue;
      const t = ler(f);
      // telefones inventados de teste seguem o formato 55 + DDD + 90000 + 4 dígitos (D21)
      const achados = (t.match(/\b55\d{10,11}\b/g) || []).filter((n) => !/^55\d{2}90000\d{4}$/.test(n));
      assert.deepEqual(achados, [], f);
    }
  });
});
