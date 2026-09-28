/*
 * Página do vendedor — cotação da Spazio Gourmet (https://spaziogourmet.github.io/cotacao/#c=<código>).
 *
 * ES2017 puro, sem módulos, sem bibliotecas e só fetch: tem de rodar no navegador embutido do WhatsApp em
 * Android de entrada. Tudo o que vem do banco entra na tela por textContent (nunca innerHTML).
 * Regras: compra-semanal/docs/DESIGN-cotacao-fornecedores.md (seção 9) e docs/contrato-1b.md (seções 5 e 9).
 *
 * A página nunca mostra último preço nem custo médio: o banco não manda (lista branca de cotacao_abrir) e aqui
 * nada procura por eles. Avisos ao vendedor vêm do banco como códigos; a página só monta o texto.
 */
(function (window) {
  'use strict';

  const document = window.document;

  // ---------- constantes

  const FORMATO_CODIGO = /^[A-Za-z0-9_-]{32}$/;
  const FORMATO_H = /^[0-9a-f]{16}$/;
  const FORMATO_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const CATORZE_DIAS_MS = 14 * 24 * 60 * 60 * 1000;
  const MAX_DEVAGAR = 5;               // tentativas automáticas seguidas depois de "devagar" (contrato 9.3)
  const TEMPO_CHAMADA_MS = 30000;
  // caracteres de controle recusados pelo banco (contrato 1.2); a observação aceita quebra de linha
  const CONTROLE = /[\u0000-\u001F\u007F-\u009F]/;
  const CONTROLE_OBS = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
  const TEXTO_CODIGO_INVALIDO = 'Este link não vale mais. Peça um novo ao Ivan pelo WhatsApp.';
  const TEXTO_WHATSAPP = 'Se não funcionar, responda pelo WhatsApp com o número do item e o preço.';
  // validade das condições anterior ao dia de hoje (o "hoje" da véspera, com a aba aberta de um dia para o outro)
  const TEXTO_VALIDADE_PASSOU = 'A data de validade já passou; escolha de novo.';
  const DIAS_CURTOS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  const DIAS_LONGOS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  // artigo, singular e plural de cada embalagem do catálogo
  const EMBALAGENS = {
    fardo: ['o', 'fardo', 'fardos'],
    caixa: ['a', 'caixa', 'caixas'],
    pacote: ['o', 'pacote', 'pacotes'],
    saco: ['o', 'saco', 'sacos']
  };
  const RESPOSTA_VAZIA = {
    estado: 'sem_resposta', preco_digitado: null, base: null, emb_unidades: null, emb_gramas: null, emb_ml: null,
    preco_convertido: null, tenho_so: null, similar_desc: null, similar_preco: null, a_partir_de: null,
    marca_informada: null, confirmado_pelo_vendedor: false, avisos_vendedor: []
  };
  const MAX_MARCA = 60;                // marca do vendedor: opcional, até 60 caracteres, só com "tem" (contrato 3.10, D50)
  const GERAIS_VAZIAS = { pagamento: null, validade: null, pedido_minimo: null, frete: null, entrega: null, observacao: null };
  const CAMPOS_GERAIS = ['pagamento', 'validade', 'pedido_minimo', 'frete', 'entrega', 'observacao'];

  // ---------- números e textos (puros)

  /**
   * Mesmo leitor do App (src/lib/regras.ts): "1,2" → 1.2 · "R$ 1.234,50" → 1234.5 · "2.79" → 2.79 ·
   * "1.250" → 1250 (milhar, sem vírgula) · "0.500" → 0.5 · vazio/negativo/inválido → null. Sem máscara de centavos.
   */
  function lerNumero(texto) {
    if (texto === null || texto === undefined) return null;
    let t = String(texto).replace(/[R$\s]/g, '');
    if (!t) return null;
    if (t.indexOf(',') >= 0) {
      t = t.replace(/\./g, '').replace(',', '.');
    } else if (/^[1-9]\d{0,2}(\.\d{3})+$/.test(t)) {
      // sem vírgula, no formato de milhar (1.250, 12.500…): os pontos são separadores, não decimal
      t = t.replace(/\./g, '');
    }
    if (!/^\d+(\.\d+)?$/.test(t)) return null;
    return Number(t);
  }

  function duasCasas(v) {
    return Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
  }

  /** Dinheiro digitado: > 0, ≤ 1.000.000 e no máximo 2 casas (contrato 1.2, D19); senão null. */
  function lerDinheiro(texto) {
    const v = lerNumero(texto);
    if (v === null || v <= 0 || v > 1000000 || !duasCasas(v)) return null;
    return Math.round(v * 100) / 100;
  }

  /** Valor das condições (pedido mínimo, frete): de 0 a 1.000.000, no máximo 2 casas. */
  function lerValorGeral(texto) {
    const v = lerNumero(texto);
    if (v === null || v < 0 || v > 1000000 || !duasCasas(v)) return null;
    return Math.round(v * 100) / 100;
  }

  /** "Tenho só" e "a partir de": > 0 e ≤ 1.000.000. */
  function lerQuantidade(texto) {
    const v = lerNumero(texto);
    if (v === null || v <= 0 || v > 1000000) return null;
    return v;
  }

  function preenchido(texto) {
    return texto !== null && texto !== undefined && String(texto).trim() !== '';
  }

  function limparTexto(texto) {
    if (texto === null || texto === undefined) return null;
    const t = String(texto).trim();
    return t ? t : null;
  }

  /** Tamanho em caracteres como o char_length do Postgres (emoji conta 1). */
  function tamanho(texto) {
    return Array.from(texto).length;
  }

  function arred(v, casas) {
    const f = Math.pow(10, casas);
    return Math.round(v * f) / f;
  }

  function pad2(n) {
    return ('0' + n).slice(-2);
  }

  /** Formata no padrão brasileiro sem depender do Intl do aparelho: 1234.5 → "1.234,50" (min 2, max 2). */
  function formatarNumero(v, minCasas, maxCasas) {
    const negativo = v < 0;
    const partes = Math.abs(v).toFixed(maxCasas).split('.');
    let inteiro = partes[0];
    let decimal = partes[1] || '';
    decimal = decimal.replace(/0+$/, '');
    while (decimal.length < minCasas) decimal += '0';
    inteiro = inteiro.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (negativo ? '-' : '') + inteiro + (decimal ? ',' + decimal : '');
  }

  function formatarReais(v) {
    return 'R$ ' + formatarNumero(Number(v), 2, 2);
  }

  /** Preço por unidade: 2 casas, e até 4 quando daria R$ 0,00. */
  function formatarReaisUn(v) {
    const n = Number(v);
    return n > 0 && n < 0.005 ? 'R$ ' + formatarNumero(n, 2, 4) : formatarReais(n);
  }

  function formatarQtd(v) {
    return formatarNumero(Number(v), 0, 3);
  }

  function plural(n, singular, plural_) {
    return Math.abs(Number(n) - 1) < 1e-9 ? singular : plural_;
  }

  function nomeEmbalagem(tipo, padrao) {
    return EMBALAGENS[tipo] || padrao || ['a', 'embalagem', 'embalagens'];
  }

  function textoPeso(kg) {
    return kg < 1 ? formatarQtd(arred(kg * 1000, 3)) + ' g' : formatarQtd(kg) + ' kg';
  }

  // ---------- sha256 (síncrono, sem crypto.subtle) e UUID

  const K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function bytesUtf8(texto) {
    const b = [];
    for (let i = 0; i < texto.length; i++) {
      let c = texto.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < texto.length) {
        const d = texto.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
          i++;
        }
      }
      if (c < 0x80) b.push(c);
      else if (c < 0x800) b.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) b.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else b.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return b;
  }

  function rotr(x, n) {
    return (x >>> n) | (x << (32 - n));
  }

  /** sha256 em hexadecimal do texto em UTF-8 (a chave do rascunho usa os 16 primeiros caracteres). */
  function sha256hex(texto) {
    const m = bytesUtf8(String(texto));
    const bits = m.length * 8;
    m.push(0x80);
    while (m.length % 64 !== 56) m.push(0);
    const alto = Math.floor(bits / 0x100000000);
    const baixo = bits >>> 0;
    m.push((alto >>> 24) & 255, (alto >>> 16) & 255, (alto >>> 8) & 255, alto & 255);
    m.push((baixo >>> 24) & 255, (baixo >>> 16) & 255, (baixo >>> 8) & 255, baixo & 255);
    const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const w = new Array(64);
    for (let i = 0; i < m.length; i += 64) {
      for (let t = 0; t < 16; t++) {
        w[t] = (m[i + 4 * t] << 24) | (m[i + 4 * t + 1] << 16) | (m[i + 4 * t + 2] << 8) | m[i + 4 * t + 3];
      }
      for (let t = 16; t < 64; t++) {
        const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (let t = 0; t < 64; t++) {
        const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[t] + w[t]) | 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }
    let s = '';
    for (let i = 0; i < 8; i++) s += ('00000000' + (h[i] >>> 0).toString(16)).slice(-8);
    return s;
  }

  /** UUID v4 gerado no aparelho (envio_id). crypto.getRandomValues quando existe; senão Math.random. */
  function novoUuid() {
    const b = [];
    let ok = false;
    try {
      const c = window.crypto || window.msCrypto;
      if (c && typeof c.getRandomValues === 'function') {
        const u = new Uint8Array(16);
        c.getRandomValues(u);
        for (let i = 0; i < 16; i++) b.push(u[i]);
        ok = true;
      }
    } catch (e) {
      ok = false;
    }
    if (!ok) {
      b.length = 0;
      for (let i = 0; i < 16; i++) b.push(Math.floor(Math.random() * 256));
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let s = '';
    for (let i = 0; i < 16; i++) {
      s += ('0' + b[i].toString(16)).slice(-2);
      if (i === 3 || i === 5 || i === 7 || i === 9) s += '-';
    }
    return s;
  }

  // ---------- endereço (só o que vem depois do "#"; ?c= nunca é lido)

  function lerHash(hash) {
    const r = { c: null, p: false, de: null };
    const s = String(hash || '').replace(/^#/, '');
    if (!s) return r;
    const partes = s.split('&');
    for (let i = 0; i < partes.length; i++) {
      const j = partes[i].indexOf('=');
      if (j < 0) continue;
      const k = partes[i].slice(0, j);
      const v = partes[i].slice(j + 1);
      if (k === 'c' && r.c === null) r.c = v;
      else if (k === 'p') r.p = v === '1';
      else if (k === 'de' && r.de === null) r.de = v;
    }
    return r;
  }

  function hashDaCotacao(codigo, previa, de) {
    return '#c=' + codigo + (de ? '&de=' + de : '') + (previa ? '&p=1' : '');
  }

  // ---------- datas: só os textos *_local do banco (a página não parseia ISO nem confia no relógio do celular)

  function partesLocal(texto) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(texto || ''));
    if (!m) return null;
    return { a: +m[1], m: +m[2], d: +m[3], h: m[4] ? +m[4] : 0, min: m[5] ? +m[5] : 0 };
  }

  function diaDaSemana(p) {
    return new Date(Date.UTC(p.a, p.m - 1, p.d)).getUTCDay();
  }

  function ddmm(p) {
    return pad2(p.d) + '/' + pad2(p.m);
  }

  /** Hora curta brasileira, como cot_hora_br: 17h, 9h07, 10h15. */
  function horaBr(p) {
    return p.h + 'h' + (p.min ? pad2(p.min) : '');
  }

  function minutosLocal(texto) {
    const p = partesLocal(texto);
    return p ? Date.UTC(p.a, p.m - 1, p.d, p.h, p.min) / 60000 : null;
  }

  function dataValida(texto) {
    const p = partesLocal(texto);
    if (!p || !/^\d{4}-\d{2}-\d{2}$/.test(texto)) return false;
    const d = new Date(Date.UTC(p.a, p.m - 1, p.d));
    return d.getUTCFullYear() === p.a && d.getUTCMonth() === p.m - 1 && d.getUTCDate() === p.d;
  }

  function somarDias(texto, dias) {
    const p = partesLocal(texto);
    const d = new Date(Date.UTC(p.a, p.m - 1, p.d) + dias * 86400000);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  /** Data digitada à mão (navegador sem calendário): "AAAA-MM-DD", "dd/mm" ou "dd/mm/aaaa". */
  function lerDataDigitada(texto, hoje) {
    const t = String(texto || '').trim();
    if (dataValida(t)) return t;
    const m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(t);
    if (!m) return null;
    const base = partesLocal(hoje);
    let ano = m[3] ? +m[3] : (base ? base.a : 0);
    if (ano < 100) ano += 2000;
    let s = ano + '-' + pad2(+m[2]) + '-' + pad2(+m[1]);
    if (!m[3] && hoje && s < hoje) s = (ano + 1) + '-' + pad2(+m[2]) + '-' + pad2(+m[1]);
    return dataValida(s) ? s : null;
  }

  /**
   * As datas de "Preço válido até" como o banco as monta (cot_validade_opcoes): hoje, amanhã, a primeira quarta e a
   * primeira sexta depois de hoje, sem repetir a data (fica o primeiro rótulo), em ordem de data. A página só usa
   * quando o dia vira com ela aberta e não dá para reabrir a cotação (sem o rascunho no aparelho): mudou lá, muda aqui.
   */
  function opcoesValidade(hoje) {
    if (typeof hoje !== 'string' || !dataValida(hoje)) return [];
    const amanha = somarDias(hoje, 1);
    const dia = diaDaSemana(partesLocal(amanha));
    const candidatas = [
      [hoje, 'hoje'], [amanha, 'amanhã'],
      [somarDias(amanha, (3 - dia + 7) % 7), 'qua'], [somarDias(amanha, (5 - dia + 7) % 7), 'sex']
    ];
    const r = [];
    for (let i = 0; i < candidatas.length; i++) {
      const data = candidatas[i][0];
      let repetida = false;
      for (let j = 0; j < r.length; j++) if (r[j].data === data) repetida = true;
      if (!repetida) r.push({ data: data, rotulo: candidatas[i][1] + ' ' + ddmm(partesLocal(data)) });
    }
    r.sort(function (a, b) { return a.data < b.data ? -1 : (a.data > b.data ? 1 : 0); });
    return r;
  }

  function textoEncerrada(fechamentoLocal) {
    const p = partesLocal(fechamentoLocal);
    if (!p) return 'Cotação encerrada. Obrigado!';
    return 'Cotação encerrada às ' + horaBr(p) + ' de ' + DIAS_CURTOS[diaDaSemana(p)] + ' ' + ddmm(p) + '. Obrigado!';
  }

  /**
   * Linha do prazo, pelo relógio do banco: segundos = quanto falta para o fechamento
   * (segundos_para_fechar menos o tempo passado desde a abertura).
   */
  function textoPrazo(dados, segundos) {
    const pz = partesLocal(dados.prazo_local);
    const fc = partesLocal(dados.fechamento_local);
    if (!pz || !fc) return '';
    if (segundos <= 0) return textoEncerrada(dados.fechamento_local);
    const antesDoPrazo = segundos - (minutosLocal(dados.fechamento_local) - minutosLocal(dados.prazo_local)) * 60;
    if (antesDoPrazo > 0) return 'Responder até ' + DIAS_LONGOS[diaDaSemana(pz)] + ', ' + ddmm(pz) + ', ' + horaBr(pz);
    return 'O prazo era ' + horaBr(pz) + ', mas ainda dá para enviar até ' + horaBr(fc) + ' de hoje';
  }

  /**
   * "Recebido às 10h42": o banco manda recebido_em em UTC (…Z) e nenhum *_local; Brasília é UTC−3 fixo
   * (sem horário de verão desde 2019), então basta tirar 3 h da hora do texto, sem Date nem fuso do aparelho.
   */
  function horaRecebido(iso) {
    const m = /T(\d{2}):(\d{2})/.exec(String(iso || ''));
    if (!m) return null;
    return horaBr({ h: (Number(m[1]) + 21) % 24, min: Number(m[2]) });
  }

  // ---------- item: quantidade, conversão, conta ao vivo e avisos (puros)

  function modoPadrao(it) {
    if (it.unidade !== 'kg') return 'un';
    return it.vende_por_litro ? 'litro' : 'kg';
  }

  function modoValido(it, modo) {
    if (it.unidade !== 'kg') return 'un';
    return modo === 'litro' || modo === 'kg' ? modo : modoPadrao(it);
  }

  function temFator(it) {
    return it.fator !== null && it.fator !== undefined && Number(it.fator) > 0;
  }

  /** "104 un → 9 fardos c/12 (108 un)", "3 sacos", "1,2 kg — cote o kg…", "19,9 kg no nosso sistema — …". */
  function textoQuantidade(it) {
    const q = Number(it.qtd);
    if (it.unidade === 'kg') {
      if (it.vende_por_litro) return formatarQtd(q) + ' kg no nosso sistema — cote o litro ou a caixa e diga os ml';
      if (temFator(it)) {
        const fator = Number(it.fator);
        const n = Math.ceil(q / fator - 1e-9);
        const e = nomeEmbalagem(it.embalagem);
        return formatarQtd(q) + ' kg → ' + n + ' ' + plural(n, e[1], e[2]) + ' de ' + textoPeso(fator) +
          ' (' + formatarQtd(arred(n * fator, 3)) + ' kg)';
      }
      return formatarQtd(q) + ' kg — cote o kg ou a sua embalagem e diga o peso';
    }
    const saco = it.rotulo === 'saco';
    const un = function (v) { return formatarQtd(v) + ' ' + (saco ? plural(v, 'saco', 'sacos') : 'un'); };
    if (temFator(it)) {
      const fator = Number(it.fator);
      const n = Math.ceil(q / fator - 1e-9);
      const e = nomeEmbalagem(it.embalagem);
      return un(q) + ' → ' + n + ' ' + plural(n, e[1], e[2]) + ' c/' + formatarQtd(fator) + ' (' + un(arred(n * fator, 3)) + ')';
    }
    return un(q);
  }

  /** "Na última nota: <descrição do fornecedor> (cód. …)" — o banco só manda quando é deste vendedor. */
  function textoUltimaNota(it) {
    const desc = limparTexto(it.descricao_fornecedor);
    const cod = limparTexto(it.codigo_fornecedor);
    if (desc && cod) return 'Na última nota: ' + desc + ' (cód. ' + cod + ')';
    if (desc) return 'Na última nota: ' + desc;
    if (cod) return 'Na última nota: cód. ' + cod;
    return null;
  }

  /** Rótulos das opções de "Esse preço é de", conforme a unidade em que o vendedor cota. */
  function rotulosBase(it, modo) {
    if (modo === 'kg') return { unidade: '1 kg', emb: 'embalagem de', sufixo: 'g', ajuda: 'Peso da embalagem, em gramas' };
    if (modo === 'litro') return { unidade: '1 L', emb: 'embalagem de', sufixo: 'ml', ajuda: 'Volume da embalagem, em ml' };
    if (it.rotulo === 'saco') return { unidade: '1 saco', emb: 'fardo com', sufixo: 'sacos', ajuda: 'Quantos sacos vêm no fardo' };
    return { unidade: '1 un', emb: 'fardo/caixa com', sufixo: 'un', ajuda: 'Quantas unidades vêm no fardo ou caixa' };
  }

  function sufixoQtd(it) {
    if (it.unidade === 'kg') return 'kg';
    return it.rotulo === 'saco' ? 'sacos' : 'un';
  }

  /**
   * Preço na unidade do SisChef, como o banco calcula (contrato 3.10): { convertido, porLitro }.
   * convertido = null quando o preço é por litro sem kg_por_litro confirmado. null quando não dá para converter.
   */
  function converter(it, e) {
    if (!e || e.estado !== 'tem' || e.preco === null || e.preco === undefined || !e.base) return null;
    const p = Number(e.preco);
    if (it.unidade !== 'kg') {
      if (e.base === 'un') return { convertido: p, porLitro: null };
      if (e.base === 'embalagem' && e.emb_unidades) return { convertido: arred(p / e.emb_unidades, 4), porLitro: null };
      return null;
    }
    const kgPorLitro = it.kg_por_litro ? Number(it.kg_por_litro) : null;
    if (e.base === 'kg') return { convertido: p, porLitro: null };
    if (e.base === 'embalagem' && e.emb_gramas && !e.emb_ml) return { convertido: arred(p / (e.emb_gramas / 1000), 4), porLitro: null };
    if (e.base === 'litro') return { convertido: kgPorLitro ? arred(p / kgPorLitro, 4) : null, porLitro: p };
    if (e.base === 'embalagem' && e.emb_ml && !e.emb_gramas) {
      const porLitro = p / (e.emb_ml / 1000);
      return { convertido: kgPorLitro ? arred(porLitro / kgPorLitro, 4) : null, porLitro: arred(porLitro, 4) };
    }
    return null;
  }

  /**
   * Conta ao vivo (spec 9): "R$ 31,50 o fardo c/6 = R$ 5,25 a un · 18 fardos (108 un) = R$ 567,00",
   * "R$ 31,00/kg × 1,2 kg = R$ 37,20" ou, por litro sem fator, só "R$ 8,00 o litro".
   */
  function contaAoVivo(it, f) {
    if (!f || f.nao_tem || !f.base) return null;
    const p = lerDinheiro(f.preco);
    if (p === null) return null;
    const q = Number(it.qtd);
    const modo = modoValido(it, f.modo);
    if (modo === 'un') {
      const saco = it.rotulo === 'saco';
      const cada = saco ? 'o saco' : 'a un';
      const un = function (v) { return formatarQtd(v) + ' ' + (saco ? plural(v, 'saco', 'sacos') : 'un'); };
      if (f.base === 'unidade') return formatarReais(p) + ' ' + cada + ' × ' + un(q) + ' = ' + formatarReais(p * q);
      const n = lerNumero(f.emb);
      if (n === null || n < 1 || Math.floor(n) !== n) return null;
      const e = nomeEmbalagem(it.embalagem, saco ? EMBALAGENS.fardo : null);
      const k = Math.ceil(q / n - 1e-9);
      return formatarReais(p) + ' ' + e[0] + ' ' + e[1] + ' c/' + formatarQtd(n) + ' = ' + formatarReaisUn(p / n) + ' ' + cada +
        ' · ' + k + ' ' + plural(k, e[1], e[2]) + ' (' + un(k * n) + ') = ' + formatarReais(k * p);
    }
    if (modo === 'kg') {
      let porKg = p;
      let prefixo = '';
      if (f.base === 'embalagem') {
        const g = lerNumero(f.emb);
        if (g === null || g <= 0) return null;
        const e = nomeEmbalagem(it.embalagem);
        porKg = arred(p / (g / 1000), 4);
        prefixo = formatarReais(p) + ' ' + e[0] + ' ' + e[1] + ' de ' + formatarQtd(g) + ' g = ';
      }
      return prefixo + formatarReaisUn(porKg) + '/kg × ' + formatarQtd(q) + ' kg = ' + formatarReais(porKg * q);
    }
    let porLitro = p;
    let prefixo = '';
    if (f.base === 'embalagem') {
      const ml = lerNumero(f.emb);
      if (ml === null || ml <= 0) return null;
      porLitro = arred(p / (ml / 1000), 4);
      prefixo = formatarReais(p) + ' a embalagem de ' + formatarQtd(ml) + ' ml = ';
    }
    if (!it.kg_por_litro) return prefixo + formatarReaisUn(porLitro) + ' o litro';
    const porKg = arred(porLitro / Number(it.kg_por_litro), 4);
    return prefixo + formatarReaisUn(porLitro) + ' o litro = ' + formatarReaisUn(porKg) + '/kg × ' + formatarQtd(q) +
      ' kg = ' + formatarReais(porKg * q);
  }

  /** Texto de um aviso ao vendedor (códigos do banco, contrato 3.10), montado com os valores do item. */
  function textoAviso(codigo, it, r) {
    if (codigo === 'centavos') {
      return formatarReais(r.preco_digitado) + ' — é isso mesmo? (não seria ' + formatarReais(Number(r.preco_digitado) * 100) + '?)';
    }
    if (codigo === 'valor_alto') {
      let v = r.preco_convertido;
      let unidade;
      if (v !== null && v !== undefined) {
        unidade = it.unidade === 'kg' ? '1 kg' : (it.rotulo === 'saco' ? '1 saco' : '1 un');
      } else {
        unidade = '1 L';
        if (r.base === 'litro') v = r.preco_digitado;
        else if (r.emb_ml) v = arred(Number(r.preco_digitado) / (Number(r.emb_ml) / 1000), 4);
      }
      if (v === null || v === undefined) return 'Valor alto — confere? Não é o total da linha?';
      return formatarReais(v) + ' por ' + unidade + ' — confere? Não é o total da linha?';
    }
    if (codigo === 'fator_diferente') {
      const e = nomeEmbalagem(it.embalagem);
      const artigo = e[0] === 'a' ? 'A' : 'O';
      const quanto = it.unidade === 'kg' ? textoPeso(Number(it.fator)) : formatarQtd(it.fator);
      return artigo + ' ' + e[1] + ' não é de ' + quanto + '?';
    }
    return null;
  }

  const TEXTOS_ERRO_ITEM = {
    numero_inexistente: 'Este item não está mais na cotação.',
    sem_preco: 'Falta o preço (ou toque em Não tenho).',
    sem_embalagem: 'Falta dizer quanto vem na embalagem.',
    valor_invalido: 'Algum número deste item está fora do esperado. Confira.',
    base_incompativel: 'Confira de que é o preço (1 un, 1 kg, embalagem…).',
    texto_invalido: 'Texto com caractere inválido ou longo demais.'
  };

  function textoErroLocal(erro, it, f) {
    const modo = modoValido(it, f.modo);
    const rot = rotulosBase(it, modo);
    if (erro.codigo === 'sem_preco') return TEXTOS_ERRO_ITEM.sem_preco;
    if (erro.codigo === 'sem_base') return 'Diga de que é o preço: toque em "' + rot.unidade + '" ou em "' + rot.emb + ' …".';
    if (erro.codigo === 'sem_embalagem') {
      if (modo === 'kg') return 'Diga o peso da embalagem, em gramas.';
      if (modo === 'litro') return 'Diga quantos ml tem a embalagem.';
      return it.rotulo === 'saco' ? 'Diga quantos sacos vêm no fardo.' : 'Diga quantas unidades vêm no fardo ou caixa.';
    }
    if (erro.codigo === 'texto_invalido') {
      if (erro.campo === 'marca') return 'A marca é longa demais (até 60 letras) ou tem caractere inválido.';
      return 'O nome do similar é longo demais (até 200 letras).';
    }
    if (erro.campo === 'preco') return 'Não entendi o preço. Use só números, com até 2 casas (ex.: 42,50).';
    if (erro.campo === 'emb') {
      if (modo === 'kg') return 'Peso da embalagem: de 1 a 100.000 g.';
      if (modo === 'litro') return 'Volume da embalagem: de 1 a 100.000 ml.';
      return 'Quantidade na embalagem: um número inteiro de 1 a 10.000.';
    }
    if (erro.campo === 'tenho_so') return 'Não entendi o "Tenho só".';
    if (erro.campo === 'a_partir_de') return 'Não entendi o "a partir de".';
    if (erro.campo === 'similar_preco') return 'Não entendi o preço do similar.';
    return TEXTOS_ERRO_ITEM.valor_invalido;
  }

  // ---------- formulário do item ↔ entrada do banco (puros)

  function numeroOuVazio(v, casas) {
    if (v === null || v === undefined || v === '') return '';
    return casas === 2 ? formatarNumero(Number(v), 2, 2) : formatarQtd(Number(v));
  }

  /** Formulário em branco; com fator confirmado, a embalagem já vem marcada (e editável). Sem fator, nada sugerido. */
  function formVazio(it) {
    const f = {
      nao_tem: false, preco: '', modo: modoPadrao(it), base: null, emb: '',
      tenho_so: '', similar_desc: '', similar_preco: '', a_partir_de: '', marca: '', confirmado: false
    };
    if (temFator(it)) {
      if (f.modo === 'un') {
        f.base = 'embalagem';
        f.emb = formatarQtd(Number(it.fator));
      } else if (f.modo === 'kg') {
        f.base = 'embalagem';
        f.emb = formatarQtd(arred(Number(it.fator) * 1000, 3));
      }
    }
    return f;
  }

  /** Formulário a partir da resposta gravada no banco (RespostaItem). */
  function formDaResposta(it, r) {
    const f = formVazio(it);
    if (!r || !r.estado || r.estado === 'sem_resposta') return f;
    f.similar_desc = r.similar_desc || '';
    f.similar_preco = numeroOuVazio(r.similar_preco, 2);
    if (r.estado === 'nao_tem') {
      f.nao_tem = true;
      return f;
    }
    f.confirmado = !!r.confirmado_pelo_vendedor;
    f.marca = r.marca_informada || '';
    f.preco = numeroOuVazio(r.preco_digitado, 2);
    f.tenho_so = numeroOuVazio(r.tenho_so);
    f.a_partir_de = numeroOuVazio(r.a_partir_de);
    f.base = null;
    f.emb = '';
    if (r.base === 'un' || r.base === 'kg' || r.base === 'litro') {
      f.base = 'unidade';
      if (it.unidade === 'kg') f.modo = r.base === 'litro' ? 'litro' : 'kg';
    } else if (r.base === 'embalagem') {
      f.base = 'embalagem';
      if (r.emb_unidades !== null && r.emb_unidades !== undefined) {
        f.emb = formatarQtd(r.emb_unidades);
      } else if (r.emb_gramas !== null && r.emb_gramas !== undefined) {
        f.modo = 'kg';
        f.emb = formatarQtd(r.emb_gramas);
      } else if (r.emb_ml !== null && r.emb_ml !== undefined) {
        f.modo = 'litro';
        f.emb = formatarQtd(r.emb_ml);
      }
    }
    return f;
  }

  /** Rascunho lido do aparelho: só os campos conhecidos, com o tipo certo (o armazenamento é de toda a origem). */
  function formDoRascunho(it, v) {
    const f = formVazio(it);
    if (!v || typeof v !== 'object') return f;
    const texto = function (x) { return typeof x === 'string' ? x.slice(0, 1000) : ''; };
    f.nao_tem = v.nao_tem === true;
    f.preco = texto(v.preco);
    f.modo = modoValido(it, v.modo);
    f.base = v.base === 'unidade' || v.base === 'embalagem' ? v.base : null;
    f.emb = texto(v.emb);
    f.tenho_so = texto(v.tenho_so);
    f.similar_desc = texto(v.similar_desc);
    f.similar_preco = texto(v.similar_preco);
    f.a_partir_de = texto(v.a_partir_de);
    f.marca = texto(v.marca);
    f.confirmado = v.confirmado === true;
    return f;
  }

  /**
   * Formulário → entrada de cotacao_responder (contrato 5.2), com a validação do banco (3.10) feita antes,
   * para não mandar o que ele recusaria. Devolve { entrada, erro } (erro = { codigo, campo }).
   */
  function entradaDoForm(it, f) {
    const e = {
      estado: 'sem_resposta', preco: null, base: null, emb_unidades: null, emb_gramas: null, emb_ml: null,
      tenho_so: null, similar_desc: null, similar_preco: null, a_partir_de: null, marca: null, confirmado: false
    };
    const falha = function (codigo, campo) { return { entrada: null, erro: { codigo: codigo, campo: campo } }; };
    const desc = limparTexto(f.similar_desc);
    if (desc !== null && (tamanho(desc) > 200 || CONTROLE.test(desc))) return falha('texto_invalido', 'similar_desc');
    let simPreco = null;
    if (preenchido(f.similar_preco)) {
      simPreco = lerDinheiro(f.similar_preco);
      if (simPreco === null) return falha('valor_invalido', 'similar_preco');
    }
    if (f.nao_tem) {
      // "não tenho" nunca leva a marca (o banco recusaria): ela só vale com "tem"
      e.estado = 'nao_tem';
      e.similar_desc = desc;
      e.similar_preco = simPreco;
      return { entrada: e, erro: null };
    }
    const marca = limparTexto(f.marca);
    if (!preenchido(f.preco) && !preenchido(f.tenho_so) && !preenchido(f.a_partir_de) && desc === null && simPreco === null && marca === null) {
      return { entrada: e, erro: null };
    }
    e.estado = 'tem';
    e.similar_desc = desc;
    e.similar_preco = simPreco;
    e.confirmado = f.confirmado === true;
    if (marca !== null && (tamanho(marca) > MAX_MARCA || CONTROLE.test(marca))) return falha('texto_invalido', 'marca');
    e.marca = marca;
    if (!preenchido(f.preco)) return falha('sem_preco', 'preco');
    e.preco = lerDinheiro(f.preco);
    if (e.preco === null) return falha('valor_invalido', 'preco');
    if (f.base !== 'unidade' && f.base !== 'embalagem') return falha('sem_base', 'base');
    const modo = modoValido(it, f.modo);
    if (f.base === 'unidade') {
      e.base = modo;
    } else {
      e.base = 'embalagem';
      if (!preenchido(f.emb)) return falha('sem_embalagem', 'emb');
      const v = lerNumero(f.emb);
      if (modo === 'un') {
        if (v === null || v < 1 || v > 10000 || Math.floor(v) !== v) return falha('valor_invalido', 'emb');
        e.emb_unidades = v;
      } else {
        if (v === null || v < 1 || v > 100000) return falha('valor_invalido', 'emb');
        if (modo === 'kg') e.emb_gramas = v;
        else e.emb_ml = v;
      }
    }
    if (preenchido(f.tenho_so)) {
      e.tenho_so = lerQuantidade(f.tenho_so);
      if (e.tenho_so === null) return falha('valor_invalido', 'tenho_so');
    }
    if (preenchido(f.a_partir_de)) {
      e.a_partir_de = lerQuantidade(f.a_partir_de);
      if (e.a_partir_de === null) return falha('valor_invalido', 'a_partir_de');
    }
    return { entrada: e, erro: null };
  }

  function vazio(x) {
    return x === null || x === undefined;
  }

  function mesmoNum(a, b) {
    if (vazio(a) || vazio(b)) return vazio(a) && vazio(b);
    return Math.abs(Number(a) - Number(b)) < 1e-9;
  }

  function mesmoTexto(a, b) {
    return (vazio(a) || a === '' ? null : a) === (vazio(b) || b === '' ? null : b);
  }

  /** A entrada é igual à resposta gravada? soValores = só estado, preço, base e embalagem (o que gera aviso). */
  function mesmaResposta(e, r, soValores) {
    const g = r || RESPOSTA_VAZIA;
    if (e.estado !== (g.estado || 'sem_resposta')) return false;
    if (e.estado === 'sem_resposta') return true;
    const valores = mesmoNum(e.preco, g.preco_digitado) && mesmoTexto(e.base, g.base) &&
      mesmoNum(e.emb_unidades, g.emb_unidades) && mesmoNum(e.emb_gramas, g.emb_gramas) && mesmoNum(e.emb_ml, g.emb_ml);
    if (soValores) return valores;
    return valores && mesmoNum(e.tenho_so, g.tenho_so) && mesmoTexto(e.similar_desc, g.similar_desc) &&
      mesmoNum(e.similar_preco, g.similar_preco) && mesmoNum(e.a_partir_de, g.a_partir_de) &&
      (e.estado !== 'tem' || (mesmoTexto(e.marca, g.marca_informada) && !!e.confirmado === !!g.confirmado_pelo_vendedor));
  }

  // ---------- condições gerais (puros)

  function geraisVazioForm() {
    return {
      pag: null, pag_dias: '', pag_outro: '', validade: null, validade_outra: false,
      minimo: null, minimo_valor: '', frete: '', entrega: null, entrega_outra: '', observacao: ''
    };
  }

  /**
   * Condições gravadas → formulário. Texto que não é uma das opções (ex.: digitado pelo Ivan) fica como "outro" —
   * inclusive "boleto" sem os dias (gravado antes ou digitado pelo Ivan): volta igual, sem virar pendência sozinho.
   */
  function formDosGerais(g, opcoes) {
    const f = geraisVazioForm();
    if (!g) return f;
    const pg = g.pagamento;
    if (pg) {
      const m = /^boleto (\d+) dias?$/.exec(pg);
      if (m) {
        f.pag = 'boleto';
        f.pag_dias = m[1];
      } else if (pg === 'Pix') {
        f.pag = 'pix';
      } else if (pg === 'à vista') {
        f.pag = 'vista';
      } else {
        f.pag = 'outro';
        f.pag_outro = pg;
      }
    }
    if (g.validade) {
      f.validade = g.validade;
      let naLista = false;
      for (let i = 0; i < (opcoes || []).length; i++) if (opcoes[i].data === g.validade) naLista = true;
      f.validade_outra = !naLista;
    }
    if (g.pedido_minimo !== null && g.pedido_minimo !== undefined) {
      if (Number(g.pedido_minimo) === 0) {
        f.minimo = 'sem';
      } else {
        f.minimo = 'valor';
        f.minimo_valor = numeroOuVazio(g.pedido_minimo, 2);
      }
    }
    f.frete = numeroOuVazio(g.frete, 2);
    const en = g.entrega;
    if (en === 'dia seguinte') f.entrega = 'seguinte';
    else if (en === '2 dias') f.entrega = '2dias';
    else if (en === 'retirar na loja') f.entrega = 'retirar';
    else if (en) {
      f.entrega = 'outra';
      f.entrega_outra = en;
    }
    f.observacao = g.observacao || '';
    return f;
  }

  /**
   * Formulário → as 6 condições, com todos os problemas na ordem da tela: { gerais, erros } (gerais = null se há
   * algum; cada erro = { campo, motivo }). Opção escolhida sem o valor que ela pede é incompleta (motivo "sem_…":
   * boleto sem os dias, "Mínimo R$" vazio, "outra data" sem data, entrega em outra data sem dizer quando) — antes
   * ela ia vazia, em silêncio. As condições só vão inteiras e certas; os preços nunca esperam por elas.
   */
  function analisarGerais(f, hoje) {
    const g = Object.assign({}, GERAIS_VAZIAS);
    const erros = [];
    const falha = function (campo, motivo) { erros.push({ campo: campo, motivo: motivo }); };
    if (f.pag === 'boleto') {
      if (!preenchido(f.pag_dias)) {
        falha('pagamento', 'sem_dias');
      } else {
        const d = lerNumero(f.pag_dias);
        if (d === null || d < 1 || d > 365 || Math.floor(d) !== d) falha('pagamento', 'dias');
        else g.pagamento = 'boleto ' + d + (d === 1 ? ' dia' : ' dias');
      }
    } else if (f.pag === 'pix') {
      g.pagamento = 'Pix';
    } else if (f.pag === 'vista') {
      g.pagamento = 'à vista';
    } else if (f.pag === 'outro') {
      g.pagamento = limparTexto(f.pag_outro);
    }
    if (g.pagamento !== null && (tamanho(g.pagamento) > 200 || CONTROLE.test(g.pagamento))) falha('pagamento', 'texto');
    if (f.validade) {
      if (!dataValida(f.validade)) falha('validade', 'data');
      else if (hoje && f.validade < hoje) falha('validade', 'passou');
      else if (hoje && f.validade > somarDias(hoje, 366)) falha('validade', 'data');
      else g.validade = f.validade;
    } else if (f.validade_outra) {
      falha('validade', 'sem_data');
    }
    if (f.minimo === 'sem') {
      g.pedido_minimo = 0;
    } else if (f.minimo === 'valor') {
      if (!preenchido(f.minimo_valor)) {
        falha('pedido_minimo', 'sem_valor');
      } else {
        g.pedido_minimo = lerValorGeral(f.minimo_valor);
        if (g.pedido_minimo === null) falha('pedido_minimo', 'valor');
      }
    }
    if (preenchido(f.frete)) {
      g.frete = lerValorGeral(f.frete);
      if (g.frete === null) falha('frete', 'valor');
    }
    if (f.entrega === 'seguinte') g.entrega = 'dia seguinte';
    else if (f.entrega === '2dias') g.entrega = '2 dias';
    else if (f.entrega === 'retirar') g.entrega = 'retirar na loja';
    else if (f.entrega === 'outra') {
      g.entrega = limparTexto(f.entrega_outra);
      if (g.entrega === null) falha('entrega', 'sem_texto');
    }
    if (g.entrega !== null && (tamanho(g.entrega) > 200 || CONTROLE.test(g.entrega))) falha('entrega', 'texto');
    g.observacao = limparTexto(f.observacao);
    if (g.observacao !== null && (tamanho(g.observacao) > 1000 || CONTROLE_OBS.test(g.observacao))) falha('observacao', 'texto');
    return { gerais: erros.length ? null : g, erros: erros };
  }

  /** Formulário → as 6 condições (a gravação troca as 6 de uma vez). Devolve { gerais, erro } (erro = o primeiro). */
  function geraisDoForm(f, hoje) {
    const x = analisarGerais(f, hoje);
    return { gerais: x.gerais, erro: x.erros.length ? x.erros[0] : null };
  }

  /** O que falta numa condição, junto do campo (campo:motivo de analisarGerais). */
  const TEXTOS_ERRO_CONDICAO = {
    'pagamento:sem_dias': 'Falta o prazo do boleto: quantos dias? (ex.: 28)',
    'pagamento:dias': 'Prazo do boleto: número de dias, de 1 a 365.',
    'pagamento:texto': 'O texto do pagamento é longo demais (até 200 letras).',
    'validade:sem_data': 'Falta a data: escolha no calendário ou toque numa das datas.',
    'validade:passou': TEXTO_VALIDADE_PASSOU,
    'validade:data': 'A validade precisa ser uma data de hoje até daqui a um ano.',
    'pedido_minimo:sem_valor': 'Falta o valor do pedido mínimo (ou toque em Sem mínimo).',
    'pedido_minimo:valor': 'Não entendi o pedido mínimo. Use só números (ex.: 300,00).',
    'frete:valor': 'Não entendi o frete. Use só números (ex.: 30,00; sem frete: 0).',
    'entrega:sem_texto': 'Falta dizer quando entrega (ex.: quinta de manhã).',
    'entrega:texto': 'O texto da entrega é longo demais (até 200 letras).',
    'observacao:texto': 'A observação é longa demais (até 1.000 letras).'
  };

  /** O aviso curto do rodapé: [o que falta, o que o toque faz] ("… — toque aqui para completar"). */
  const AVISOS_CONDICAO = {
    'pagamento:sem_dias': ['Falta o prazo do boleto', 'completar'],
    'pagamento:dias': ['O prazo do boleto não está certo', 'corrigir'],
    'pagamento:texto': ['O texto do pagamento é longo demais', 'corrigir'],
    'validade:sem_data': ['Falta a data de validade', 'completar'],
    'validade:passou': ['A data de validade já passou', 'escolher de novo'],
    'validade:data': ['A data de validade não vale', 'corrigir'],
    'pedido_minimo:sem_valor': ['Falta o valor do pedido mínimo', 'completar'],
    'pedido_minimo:valor': ['Não entendi o pedido mínimo', 'corrigir'],
    'frete:valor': ['Não entendi o frete', 'corrigir'],
    'entrega:sem_texto': ['Falta dizer quando entrega', 'completar'],
    'entrega:texto': ['O texto da entrega é longo demais', 'corrigir'],
    'observacao:texto': ['A observação é longa demais', 'corrigir']
  };

  function mesmosGerais(a, b) {
    const x = a || GERAIS_VAZIAS;
    const y = b || GERAIS_VAZIAS;
    return mesmoTexto(x.pagamento, y.pagamento) && mesmoTexto(x.validade, y.validade) &&
      mesmoNum(x.pedido_minimo, y.pedido_minimo) && mesmoNum(x.frete, y.frete) &&
      mesmoTexto(x.entrega, y.entrega) && mesmoTexto(x.observacao, y.observacao);
  }

  function formDoRascunhoGerais(v) {
    const f = geraisVazioForm();
    if (!v || typeof v !== 'object') return f;
    const texto = function (x) { return typeof x === 'string' ? x.slice(0, 2000) : ''; };
    f.pag = ['boleto', 'pix', 'vista', 'outro'].indexOf(v.pag) >= 0 ? v.pag : null;
    f.pag_dias = texto(v.pag_dias);
    f.pag_outro = texto(v.pag_outro);
    f.validade = typeof v.validade === 'string' && dataValida(v.validade) ? v.validade : null;
    f.validade_outra = v.validade_outra === true;
    f.minimo = v.minimo === 'sem' || v.minimo === 'valor' ? v.minimo : null;
    f.minimo_valor = texto(v.minimo_valor);
    f.frete = texto(v.frete);
    f.entrega = ['seguinte', '2dias', 'retirar', 'outra'].indexOf(v.entrega) >= 0 ? v.entrega : null;
    f.entrega_outra = texto(v.entrega_outra);
    f.observacao = texto(v.observacao);
    return f;
  }

  function textoGerais(g) {
    const x = g || GERAIS_VAZIAS;
    const partes = [];
    if (x.pagamento) partes.push(x.pagamento);
    const v = partesLocal(x.validade);
    if (v) partes.push('válido até ' + ddmm(v));
    if (!vazio(x.pedido_minimo)) partes.push(Number(x.pedido_minimo) === 0 ? 'sem mínimo' : 'mínimo ' + formatarReais(x.pedido_minimo));
    if (!vazio(x.frete)) partes.push('frete ' + formatarReais(x.frete));
    if (x.entrega) partes.push('entrega: ' + x.entrega);
    if (x.observacao) partes.push('obs.: ' + x.observacao);
    return partes.length ? partes.join(' · ') : 'nenhuma condição';
  }

  // ---------- montagem do envio (puro)

  /**
   * Só o que mudou desde o último envio confirmado: itens com rascunho (sem conflito à espera de escolha)
   * e as condições, cada um com o rev que a página conhece (rev_lida). Itens com erro local ficam de fora.
   */
  function montarEnvio(itens, gerais) {
    const p_itens = [];
    const numeros = [];
    const invalidos = [];
    for (let i = 0; i < itens.length; i++) {
      const ei = itens[i];
      if (!ei.rascunho || ei.conflito) continue;
      const r = entradaDoForm(ei.item, ei.form);
      if (r.erro) {
        invalidos.push(ei.item.numero);
        continue;
      }
      const e = r.entrada;
      const x = { numero: ei.item.numero, rev_lida: ei.rascunho.rev, estado: e.estado };
      if (e.estado === 'nao_tem') {
        x.similar_desc = e.similar_desc;
        x.similar_preco = e.similar_preco;
      } else if (e.estado === 'tem') {
        x.preco = e.preco;
        x.base = e.base;
        x.emb_unidades = e.emb_unidades;
        x.emb_gramas = e.emb_gramas;
        x.emb_ml = e.emb_ml;
        x.tenho_so = e.tenho_so;
        x.similar_desc = e.similar_desc;
        x.similar_preco = e.similar_preco;
        x.a_partir_de = e.a_partir_de;
        x.marca = e.marca;
        x.confirmado = e.confirmado;
      }
      p_itens.push(x);
      numeros.push(ei.item.numero);
    }
    let p_gerais = null;
    let geraisInvalidas = false;
    if (gerais && gerais.rascunho && !gerais.conflito) {
      const r = geraisDoForm(gerais.form, gerais.hoje);
      if (r.erro) geraisInvalidas = true;
      else p_gerais = Object.assign({ rev_lida: gerais.rascunho.rev }, r.gerais);
    }
    return { p_itens: p_itens, p_gerais: p_gerais, numeros: numeros, invalidos: invalidos, geraisInvalidas: geraisInvalidas };
  }

  // ---------- rascunho no aparelho (localStorage, sempre com try/catch; sem ele a página funciona)

  function chaveItem(h, numero) { return 'cot:' + h + ':' + numero; }
  function chaveGerais(h) { return 'cot:' + h + ':gerais'; }
  function chaveEnvio(h) { return 'cot:' + h + ':envio'; }

  function obterArmazenamento() {
    try {
      const s = window.localStorage;
      if (!s) return null;
      s.getItem('cot:');
      return s;
    } catch (e) {
      return null;
    }
  }

  function lerJson(s, k) {
    if (!s) return null;
    try {
      const v = s.getItem(k);
      if (v === null || v === undefined) return null;
      const o = JSON.parse(v);
      return o && typeof o === 'object' ? o : null;
    } catch (e) {
      return null;
    }
  }

  function gravarJson(s, k, o) {
    if (!s) return false;
    try {
      s.setItem(k, JSON.stringify(o));
      return true;
    } catch (e) {
      return false;
    }
  }

  function apagarChave(s, k) {
    if (!s) return;
    try {
      s.removeItem(k);
    } catch (e) {
      // sem armazenamento: nada a apagar
    }
  }

  function chavesCot(s, prefixo) {
    const r = [];
    if (!s) return r;
    try {
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k && k.indexOf(prefixo || 'cot:') === 0) r.push(k);
      }
    } catch (e) {
      return [];
    }
    return r;
  }

  /** Ao abrir: apaga toda chave cot: com t de mais de 14 dias (ou ilegível). */
  function limparRascunhosVelhos(s, agora) {
    const ks = chavesCot(s);
    for (let i = 0; i < ks.length; i++) {
      const o = lerJson(s, ks[i]);
      if (!o || typeof o.t !== 'number' || agora - o.t > CATORZE_DIAS_MS) apagarChave(s, ks[i]);
    }
  }

  /** Há rascunho não enviado desta cotação (itens ou condições)? */
  function temRascunho(s, h) {
    const ks = chavesCot(s, 'cot:' + h + ':');
    for (let i = 0; i < ks.length; i++) if (ks[i] !== chaveEnvio(h)) return true;
    return false;
  }

  // ---------- depois do fechamento: a abertura vem sem itens, então só o aparelho sabe o que ficou

  /** Rascunhos desta cotação no aparelho: { itens: [{numero, r}] por número, gerais: r | null } (r = o JSON guardado). */
  function rascunhosGuardados(s, h) {
    const g = { itens: [], gerais: null };
    if (!s || !h) return g;
    const pre = 'cot:' + h + ':';
    const ks = chavesCot(s, pre);
    for (let i = 0; i < ks.length; i++) {
      const resto = ks[i].slice(pre.length);
      const r = lerJson(s, ks[i]);
      if (!r || !r.v || typeof r.v !== 'object') continue;
      if (resto === 'gerais') g.gerais = r;
      else if (/^[1-9]\d{0,5}$/.test(resto)) g.itens.push({ numero: Number(resto), r: r });
    }
    g.itens.sort(function (a, b) { return a.numero - b.numero; });
    return g;
  }

  /**
   * Envio sem confirmação guardado no ENVIAR (contrato 9.5: envio_id + o corpo mandado), só com o que ainda tem
   * rascunho (o item que o vendedor desfez depois não vai). null = nada a refazer.
   */
  function envioGuardado(s, h, guardados) {
    const pe = lerJson(s, chaveEnvio(h));
    if (!pe || typeof pe.envio_id !== 'string' || !FORMATO_UUID.test(pe.envio_id)) return null;
    const temItem = {};
    for (let i = 0; i < guardados.itens.length; i++) temItem[guardados.itens[i].numero] = true;
    const p_itens = [];
    const lista = Array.isArray(pe.p_itens) ? pe.p_itens : [];
    for (let i = 0; i < lista.length; i++) {
      const x = lista[i];
      if (x && typeof x === 'object' && temItem[x.numero] === true) p_itens.push(x);
    }
    const p_gerais = guardados.gerais && pe.p_gerais && typeof pe.p_gerais === 'object' ? pe.p_gerais : null;
    if (!p_itens.length && !p_gerais) return null;
    return { envio_id: pe.envio_id, p_itens: p_itens, p_gerais: p_gerais };
  }

  /**
   * Resultado do envio refeito depois do fechamento: apaga do aparelho cada rascunho que bate com o valor gravado
   * (item: a entrada "e" guardada com o rascunho; condições: o formulário guardado). Devolve o que chegou.
   */
  function conferirChegada(s, h, j) {
    const chegou = { numeros: [], gerais: false, hora: horaRecebido(j.recebido_em) };
    const itens = Array.isArray(j.itens) ? j.itens : [];
    for (let i = 0; i < itens.length; i++) {
      const r = itens[i];
      if (!r || r.resultado !== 'gravado' || !r.valor_atual) continue;
      const k = chaveItem(h, r.numero);
      const guardado = lerJson(s, k);
      if (guardado && guardado.e && typeof guardado.e === 'object' && mesmaResposta(guardado.e, r.valor_atual)) {
        apagarChave(s, k);
        chegou.numeros.push(r.numero);
      }
    }
    const rg = j.gerais;
    if (rg && rg.resultado === 'gravado' && rg.valor_atual) {
      const guardado = lerJson(s, chaveGerais(h));
      const x = guardado && guardado.v ? geraisDoForm(formDoRascunhoGerais(guardado.v), null) : null;
      if (x && x.gerais && mesmosGerais(x.gerais, rg.valor_atual)) {
        apagarChave(s, chaveGerais(h));
        chegou.gerais = true;
      }
    }
    chegou.numeros.sort(function (a, b) { return a - b; });
    return chegou;
  }

  function juntarComE(lista) {
    if (lista.length <= 1) return lista.join('');
    return lista.slice(0, -1).join(', ') + ' e ' + lista[lista.length - 1];
  }

  /** "O preço do item 2" · "Os preços dos itens 2 e 5" · "As condições" (juntos por "e"); plural para o verbo. */
  function partesDoAviso(numeros, gerais) {
    const partes = [];
    if (numeros.length === 1) partes.push('o preço do item ' + numeros[0]);
    else if (numeros.length > 1) partes.push('os preços dos itens ' + juntarComE(numeros));
    if (gerais) partes.push('as condições');
    const t = partes.join(' e ');
    return { texto: t.charAt(0).toUpperCase() + t.slice(1), plural: numeros.length > 1 || !!gerais };
  }

  /** O valor que o vendedor digitou no rascunho de um item (para ele mandar pelo WhatsApp). */
  function textoDoRascunho(v) {
    if (v.nao_tem === true) return '"Não tenho"';
    const preco = typeof v.preco === 'string' ? v.preco : '';
    const p = lerDinheiro(preco);
    if (p !== null) return formatarReais(p);
    return preenchido(preco) ? preco.trim().slice(0, 40) : 'sem preço';
  }

  function textoDoRascunhoGerais(v) {
    const x = geraisDoForm(formDoRascunhoGerais(v), null);
    return x.gerais ? textoGerais(x.gerais) : 'incompletas';
  }

  // ---------- rede

  /** "A Spazio recebe mercadoria: <RECEBIMENTO do config.js>"; ausente ou vazio → a linha não aparece (contrato 9.2). */
  function textoRecebimento() {
    const c = window.COTACAO_CONFIG;
    const r = c && typeof c.RECEBIMENTO === 'string' ? c.RECEBIMENTO.trim() : '';
    return r ? 'A Spazio recebe mercadoria: ' + r : null;
  }

  function configuracao() {
    const c = window.COTACAO_CONFIG;
    if (!c || typeof c.SUPABASE_URL !== 'string' || typeof c.SUPABASE_ANON_KEY !== 'string') return null;
    const url = c.SUPABASE_URL.trim();
    const chave = c.SUPABASE_ANON_KEY.trim();
    if (!url || !chave || /^__.*__$/.test(url) || /^__.*__$/.test(chave)) return null;
    return { url: url.replace(/\/+$/, ''), chave: chave };
  }

  /**
   * POST {SUPABASE_URL}/rest/v1/rpc/<nome> (contrato 9.3). Devolve sempre uma promessa que resolve em
   * { ok: true, json } (HTTP 200 com JSON) ou { ok: false } (HTTP ≠ 200, rede caída, tempo esgotado, JSON ilegível).
   */
  function chamar(nome, corpo) {
    const cfg = configuracao();
    const cabecalhos = { 'apikey': cfg.chave, 'Content-Type': 'application/json', 'Accept': 'application/json' };
    // chave anônima legada (JWT) vai também no Authorization; a nova "sb_publishable_…" só no apikey
    if (cfg.chave.indexOf('eyJ') === 0) cabecalhos.Authorization = 'Bearer ' + cfg.chave;
    const opcoes = {
      method: 'POST', headers: cabecalhos, body: JSON.stringify(corpo),
      cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer'
    };
    let controle = null;
    try {
      if (typeof window.AbortController === 'function') {
        controle = new window.AbortController();
        opcoes.signal = controle.signal;
      }
    } catch (e) {
      controle = null;
    }
    return new Promise(function (resolver) {
      let feito = false;
      const terminar = function (r) {
        if (feito) return;
        feito = true;
        window.clearTimeout(relogio);
        resolver(r);
      };
      const relogio = window.setTimeout(function () {
        try { if (controle) controle.abort(); } catch (e) { /* nada */ }
        terminar({ ok: false, motivo: 'tempo' });
      }, TEMPO_CHAMADA_MS);
      let promessa;
      try {
        promessa = window.fetch(cfg.url + '/rest/v1/rpc/' + nome, opcoes);
      } catch (e) {
        terminar({ ok: false, motivo: 'rede' });
        return;
      }
      promessa.then(function (resposta) {
        if (!resposta || resposta.status !== 200) return { ok: false, motivo: 'http' };
        return resposta.json().then(function (j) {
          return j && typeof j === 'object' && !Array.isArray(j) ? { ok: true, json: j } : { ok: false, motivo: 'json' };
        }, function () {
          return { ok: false, motivo: 'json' };
        });
      }).then(terminar, function () {
        terminar({ ok: false, motivo: 'rede' });
      });
    });
  }

  // ---------- tela: auxiliares de DOM (texto sempre por textContent)

  function el(tag, props, filhos) {
    const n = document.createElement(tag);
    if (props) {
      const chaves = Object.keys(props);
      for (let i = 0; i < chaves.length; i++) {
        const k = chaves[i];
        const v = props[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'texto') n.textContent = String(v);
        else if (k === 'classe') n.className = v;
        else if (k === 'hidden') n.hidden = true;
        else n.setAttribute(k, v === true ? '' : String(v));
      }
    }
    if (filhos) {
      for (let i = 0; i < filhos.length; i++) {
        const f = filhos[i];
        if (f === null || f === undefined || f === false) continue;
        n.appendChild(typeof f === 'string' ? document.createTextNode(f) : f);
      }
    }
    return n;
  }

  function limpar(n) {
    while (n.firstChild) n.removeChild(n.firstChild);
  }

  function porId(id) {
    return document.getElementById(id);
  }

  function marcar(botao, ligado) {
    botao.setAttribute('aria-pressed', ligado ? 'true' : 'false');
  }

  function valorCampo(campo, texto) {
    // só escreve quando mudou: não mexe no cursor de quem está digitando
    if (campo.value !== texto) campo.value = texto;
  }

  function rolarAte(n) {
    if (n && typeof n.scrollIntoView === 'function') {
      try { n.scrollIntoView({ block: 'center' }); } catch (e) { n.scrollIntoView(); }
    }
  }

  function agoraMs() {
    return Date.now();
  }

  /**
   * Dia de hoje em Brasília pelo relógio do banco: agora_local + o tempo passado desde a abertura (Date.now()
   * relativo, como o fechamento; contrato 9.3), sem olhar a data do celular. null sem agora_local legível.
   */
  function diaLocalAgora(esta) {
    const m = minutosLocal(esta && esta.dados && esta.dados.agora_local);
    if (m === null) return null;
    const d = new Date(m * 60000 + Math.max(0, agoraMs() - esta.aberturaMs));
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  // ---------- estado da página

  let P = null;           // página atual (refeita a cada iniciar)
  let relogioId = null;   // intervalo do relógio do fechamento
  let logoPronto = false;

  function prepararLogo() {
    if (logoPronto) return;
    logoPronto = true;
    const logo = porId('logo');
    if (!logo) return;
    // a página esconde o logo se ele não carregar
    logo.addEventListener('load', function () { logo.hidden = false; });
    logo.addEventListener('error', function () { logo.hidden = true; });
    logo.setAttribute('src', 'logo.png');
  }

  function mostrarTopo(dados) {
    const titulo = porId('titulo');
    const sub = porId('subtitulo');
    if (titulo) {
      let t = (dados && dados.loja) || 'Spazio Gourmet';
      if (dados && dados.vendedor_nome) {
        t += ' · Cotação para ' + dados.vendedor_nome + ' · ' + (dados.complementar ? 'complementar' : 'v' + dados.versao);
      } else {
        t += ' · Cotação';
      }
      titulo.textContent = t;
    }
    if (sub) {
      const linhas = [];
      if (dados && dados.complementar) linhas.push('Cotação complementar — itens novos desta semana');
      if (dados && dados.substitui_versao) {
        linhas.push('Cotação v' + dados.versao + ' — substitui a v' + dados.substitui_versao +
          '; os números dos itens continuam os mesmos, itens novos no fim');
      }
      sub.textContent = linhas.join(' · ');
      sub.hidden = linhas.length === 0;
    }
  }

  function mostrarFaixas(vista) {
    const formulario = vista === 'form';
    porId('faixa-cotacao').hidden = !formulario;
    porId('faixa-previa').hidden = !(formulario && P && P.previa);
    porId('rodape').hidden = !formulario || !P || P.previa;
    if (!formulario) porId('faixa-pendente').hidden = true;
  }

  function pararRelogio() {
    if (relogioId !== null) {
      window.clearInterval(relogioId);
      relogioId = null;
    }
  }

  /**
   * O que ainda não chegou ao banco, no formato de rascunhosGuardados: com o formulário montado (recusa "estado"
   * de um ENVIAR com a página aberta), os rascunhos da tela — valem mesmo sem localStorage; senão, os do aparelho.
   */
  function rascunhosPendentes(esta) {
    if (!esta.itens.length) return rascunhosGuardados(esta.storage, esta.h);
    const g = { itens: [], gerais: null };
    for (let i = 0; i < esta.itens.length; i++) {
      const ei = esta.itens[i];
      if (ei.rascunho) g.itens.push({ numero: ei.item.numero, r: { v: ei.form } });
    }
    if (esta.gerais && esta.gerais.rascunho) g.gerais = { v: esta.gerais.form };
    return g;
  }

  /**
   * Tela de estado (encerrada, pedido confirmado, substituída, código inválido…): o texto do banco e, se o
   * aparelho guardou algo desta cotação, o que chegou (envio refeito ao reabrir) e o que não chegou ao Ivan.
   * d.chegou = { numeros, gerais, hora } · d.semConfirmacao = o envio refeito ficou sem resposta.
   */
  function mostrarEstado(d) {
    pararRelogio();
    if (P) P.vista = 'estado';
    mostrarFaixas('estado');
    const c = porId('conteudo');
    limpar(c);
    const cartao = el('section', { classe: 'cartao estado', 'data-estado': d.estado || '' });
    cartao.appendChild(el('p', { classe: 'estado-texto', texto: d.texto || TEXTO_CODIGO_INVALIDO }));
    // estados passageiros (rede, devagar, limite) não dizem nada sobre o rascunho; a substituída leva o
    // rascunho pelo "Levar os preços" na versão nova (&de)
    const passageiro = ['falha', 'devagar', 'limite', 'nao_configurada'].indexOf(d.estado) >= 0;
    const guardados = !passageiro && P && !P.previa ? rascunhosPendentes(P) : { itens: [], gerais: null };
    const faltam = guardados.itens.map(function (x) { return x.numero; });
    const avisarFaltam = d.estado !== 'substituida' && (faltam.length > 0 || !!guardados.gerais);
    const ch = d.chegou;
    if (ch && (ch.numeros.length || ch.gerais)) {
      const hora = ch.hora ? ' às ' + ch.hora : '';
      let t;
      if (!faltam.length && !guardados.gerais) {
        t = (ch.numeros.length ? 'Seus preços chegaram' : 'Suas condições chegaram') + hora + '.';
      } else {
        const pc = partesDoAviso(ch.numeros, ch.gerais);
        t = pc.texto + (pc.plural ? ' chegaram' : ' chegou') + ' ao Ivan' + hora + '.';
      }
      cartao.appendChild(el('p', { classe: 'chegou', id: 'chegou', role: 'status', texto: t }));
    }
    if (d.semConfirmacao && d.estado !== 'substituida') {
      cartao.appendChild(el('p', {
        classe: 'sem-confirmacao', id: 'sem-confirmacao',
        texto: 'Não consegui confirmar se o seu último envio chegou. Confira a internet e toque em Tentar de novo.'
      }));
    }
    if (avisarFaltam) {
      const pf = partesDoAviso(faltam, !!guardados.gerais);
      const caixa = el('div', { classe: 'nao-chegou', id: 'nao-chegou', role: 'alert' });
      caixa.appendChild(el('p', {
        classe: 'aviso', id: 'nao-chegou-texto',
        texto: pf.texto + ' que você preencheu ' + (pf.plural ? 'não chegaram' : 'não chegou') + ' ao Ivan. Mande pelo WhatsApp' +
          (faltam.length ? ' com o número do item e o preço:' : ':')
      }));
      const lista = el('ul', { classe: 'nao-chegou-lista' });
      for (let i = 0; i < guardados.itens.length; i++) {
        lista.appendChild(el('li', { texto: 'Item ' + guardados.itens[i].numero + ': ' + textoDoRascunho(guardados.itens[i].r.v) }));
      }
      if (guardados.gerais) lista.appendChild(el('li', { texto: 'Condições: ' + textoDoRascunhoGerais(guardados.gerais.v) }));
      caixa.appendChild(lista);
      cartao.appendChild(caixa);
    }
    if (d.estado === 'substituida' && d.nova && FORMATO_CODIGO.test(String(d.nova.codigo || ''))) {
      // leva o hash desta versão só se houver rascunho não enviado dela ("Levar os preços" na nova)
      const de = P && P.h && !P.previa && temRascunho(P.storage, P.h) ? P.h : null;
      cartao.appendChild(el('a', {
        classe: 'botao', id: 'abrir-nova', href: hashDaCotacao(d.nova.codigo, P && P.previa, de),
        texto: 'Abrir a versão nova'
      }));
    }
    if (d.tentar || (d.semConfirmacao && d.estado !== 'substituida')) {
      const b = el('button', { type: 'button', classe: 'botao', id: 'tentar-de-novo', texto: 'Tentar de novo' });
      b.addEventListener('click', function () { if (P) abrir(P); });
      cartao.appendChild(b);
    }
    if (d.whatsapp) cartao.appendChild(el('p', { classe: 'dica', texto: TEXTO_WHATSAPP }));
    c.appendChild(cartao);
  }

  function mostrarCarregando() {
    const c = porId('conteudo');
    limpar(c);
    c.appendChild(el('p', { classe: 'carregando', role: 'status', texto: 'Carregando a cotação…' }));
  }

  // ---------- início

  function iniciar() {
    pararRelogio();
    prepararLogo();
    const ctx = lerHash(window.location.hash);
    P = {
      codigo: ctx.c, previa: ctx.p, de: null, h: null, dados: null, itens: [], gerais: null,
      envio: null, enviando: false, aguardando: false, devagarSeguidos: 0, recebidoEm: null,
      aberturaMs: 0, dia: null, fechado: false, falhaRede: false, mensagem: null, storage: null, vista: null,
      viewPrazo: null, viewContador: null
    };
    mostrarTopo(null);
    if (!configuracao()) {
      mostrarEstado({ estado: 'nao_configurada', texto: 'Página ainda não configurada.' });
      return Promise.resolve();
    }
    if (!P.codigo || !FORMATO_CODIGO.test(P.codigo)) {
      // código fora do formato nunca existe no banco: nem chama (não gasta o balde de inválidos)
      mostrarEstado({ estado: 'codigo_invalido', texto: TEXTO_CODIGO_INVALIDO });
      return Promise.resolve();
    }
    P.h = sha256hex(P.codigo).slice(0, 16);
    if (ctx.de && FORMATO_H.test(ctx.de) && ctx.de !== P.h && !P.previa) P.de = ctx.de;
    if (ctx.de) {
      // depois de tratar o "de", tira-o do endereço (contrato 9.4)
      try {
        window.history.replaceState(null, '', window.location.pathname + window.location.search + hashDaCotacao(P.codigo, P.previa, null));
      } catch (e) {
        // navegador sem replaceState: o "de" fica no endereço, sem efeito depois de tratado
      }
    }
    if (!P.previa) {
      P.storage = obterArmazenamento();
      limparRascunhosVelhos(P.storage, agoraMs());
    }
    mostrarCarregando();
    return abrir(P);
  }

  function abrir(esta) {
    // também reabre a cotação com a página montada (o dia virou): nada do formulário velho vale enquanto carrega
    pararRelogio();
    esta.vista = 'carregando';
    mostrarFaixas('carregando');
    mostrarCarregando();
    return chamar('cotacao_abrir', { p_codigo: esta.codigo, p_previa: esta.previa }).then(function (r) {
      if (P !== esta) return;
      if (!r.ok) {
        mostrarEstado({ estado: 'falha', texto: 'Não consegui abrir a cotação. Confira a internet e tente de novo.', tentar: true, whatsapp: true });
        return;
      }
      const d = r.json;
      if (d.ok !== true) {
        mostrarEstado({ estado: d.erro || 'codigo_invalido', texto: d.texto || TEXTO_CODIGO_INVALIDO, tentar: d.erro === 'devagar' || d.erro === 'limite' });
        return;
      }
      esta.dados = d;
      esta.aberturaMs = agoraMs();
      esta.dia = diaLocalAgora(esta);
      mostrarTopo(d);
      if (d.estado !== 'aberta') return depoisDoFechamento(esta, d);
      if (!Array.isArray(d.itens)) {
        mostrarEstado({ estado: 'falha', texto: 'Não consegui ler a cotação.', tentar: true, whatsapp: true });
        return;
      }
      esta.fechado = false;   // quem diz se já fechou é o segundos_para_fechar desta abertura
      montarModelo(esta, d);
      montarFormulario(esta);
      relogioId = window.setInterval(atualizarRelogio, 15000);
      atualizarRelogio();
    });
  }

  /**
   * Cotação que não está mais aberta (encerrada, pedido confirmado, substituída…). Se o aparelho guardou um envio
   * sem confirmação, refaz esse envio antes (mesmo envio_id e o corpo guardado, só com o que ainda tem rascunho —
   * a abertura agora vem sem itens): se ele tinha chegado, o banco devolve o resultado (reenvio); se não, ainda
   * aceita até o fechamento + 5 min (contrato 5.2, passos 4 e 5). Depois mostra o estado com o que chegou e o
   * que ficou só no celular (spec 9: a tela nunca diz só "Obrigado!" com preço não enviado no aparelho).
   */
  function depoisDoFechamento(esta, d) {
    const s = esta.storage;
    const envio = s ? envioGuardado(s, esta.h, rascunhosGuardados(s, esta.h)) : null;
    if (!envio) {
      apagarChave(s, chaveEnvio(esta.h));   // sem o que refazer (nada guardado, tudo desfeito ou formato antigo)
      mostrarEstado(d);
      return undefined;
    }
    const corpo = { p_codigo: esta.codigo, p_envio_id: envio.envio_id, p_itens: envio.p_itens, p_gerais: envio.p_gerais };
    return chamar('cotacao_responder', corpo).then(function (r) {
      if (P !== esta) return;
      const extra = {};
      if (r.ok && r.json.ok === true) {
        apagarChave(s, chaveEnvio(esta.h));
        extra.chegou = conferirChegada(s, esta.h, r.json);
      } else if (r.ok && ['estado', 'codigo_invalido', 'formato', 'envio_de_outra_cotacao'].indexOf(r.json.erro) >= 0) {
        apagarChave(s, chaveEnvio(esta.h));   // o banco nunca gravou este envio e não aceita mais: fica o aviso
      } else {
        extra.semConfirmacao = true;          // sem rede, devagar, limite: o envio fica guardado para "Tentar de novo"
      }
      mostrarEstado(Object.assign({}, d, extra));
    });
  }

  function montarModelo(esta, d) {
    const s = esta.storage;
    const itens = d.itens.slice().sort(function (a, b) { return a.numero - b.numero; });
    esta.itens = [];
    for (let i = 0; i < itens.length; i++) {
      const it = itens[i];
      const ei = {
        item: it, rev: Number(it.rev) || 0, servidor: it.resposta || RESPOSTA_VAZIA, form: null,
        rascunho: null, conflito: false, erroServidor: null, mostrarErro: false, view: null, maisAberto: false
      };
      ei.form = formDaResposta(it, ei.servidor);
      const r = lerJson(s, chaveItem(esta.h, it.numero));
      if (r && r.v && typeof r.rev === 'number') {
        const f = formDoRascunho(it, r.v);
        const e = entradaDoForm(it, f).entrada;
        if (e && mesmaResposta(e, ei.servidor)) {
          apagarChave(s, chaveItem(esta.h, it.numero));   // o banco já tem exatamente isso
        } else {
          ei.form = f;
          ei.rascunho = { rev: r.rev };
        }
      }
      esta.itens.push(ei);
    }
    const opcoes = Array.isArray(d.validade_opcoes) ? d.validade_opcoes : [];
    const g = {
      servidor: d.gerais || null, rev: Number(d.gerais_rev) || 0, form: formDosGerais(d.gerais, opcoes),
      rascunho: null, conflito: false, erroServidor: null, mostrarErro: false, opcoes: opcoes,
      hoje: opcoes.length ? opcoes[0].data : null, view: null
    };
    const rg = lerJson(s, chaveGerais(esta.h));
    if (rg && rg.v && typeof rg.rev === 'number') {
      const f = formDoRascunhoGerais(rg.v);
      const x = geraisDoForm(f, g.hoje);
      if (x.gerais && mesmosGerais(x.gerais, g.servidor)) {
        apagarChave(s, chaveGerais(esta.h));
      } else {
        g.form = f;
        g.rascunho = { rev: rg.rev };
        // condições guardadas que não podem ir como estão (a validade de ontem, o boleto sem os dias de quem fechou a
        // aba depois de mandar os preços): o aviso aparece de cara, não só no próximo ENVIAR
        if (!x.gerais) g.mostrarErro = true;
      }
    }
    esta.gerais = g;
    // envio pendente (sem confirmação): o mesmo envio_id volta a ser usado na próxima tentativa
    esta.envio = null;
    const pe = lerJson(s, chaveEnvio(esta.h));
    if (pe && typeof pe.envio_id === 'string' && FORMATO_UUID.test(pe.envio_id)) {
      if (haAlteracao(esta)) esta.envio = { envio_id: pe.envio_id, numeros: pe.numeros || [], gerais: !!pe.gerais };
      else apagarChave(s, chaveEnvio(esta.h));
    }
  }

  function haAlteracao(esta) {
    for (let i = 0; i < esta.itens.length; i++) if (esta.itens[i].rascunho) return true;
    return !!(esta.gerais && esta.gerais.rascunho);
  }

  function pendente(esta) {
    return !!esta.envio || haAlteracao(esta);
  }

  function haEnviavel(esta) {
    const m = montarEnvio(esta.itens, esta.gerais);
    return m.p_itens.length > 0 || m.p_gerais !== null;
  }

  // ---------- formulário

  function montarFormulario(esta) {
    esta.vista = 'form';
    mostrarFaixas('form');
    const c = porId('conteudo');
    limpar(c);
    c.classList.remove('fechada');   // reaberta (o dia virou): quem trava de novo é o relógio desta abertura
    const d = esta.dados;

    const info = el('section', { classe: 'info' });
    esta.viewPrazo = el('p', { classe: 'prazo', id: 'prazo' });
    esta.viewContador = el('p', { classe: 'contador', id: 'contador' });
    info.appendChild(esta.viewPrazo);
    info.appendChild(esta.viewContador);
    c.appendChild(info);

    const oferta = montarOfertaLevar(esta);
    if (oferta) c.appendChild(oferta);

    const lista = el('div', { classe: 'itens' });
    for (let i = 0; i < esta.itens.length; i++) {
      const v = montarItem(esta.itens[i]);
      lista.appendChild(v.raiz);
    }
    c.appendChild(lista);
    c.appendChild(montarGerais(esta.gerais));

    const avisar = porId('avisar-ivan');
    avisar.setAttribute('href', 'https://wa.me/?text=' + encodeURIComponent('Ivan, respondi a cotação da Spazio (v' + Number(d.versao) + ').'));
    for (let i = 0; i < esta.itens.length; i++) sincronizarItem(esta.itens[i]);
    sincronizarGerais(esta.gerais);
    if (esta.previa) travarFormulario(true);
    atualizarGeral();
  }

  // --- levar o rascunho não enviado da versão substituída (&de=<h antigo>)

  function montarOfertaLevar(esta) {
    if (!esta.de || esta.previa || !esta.storage) return null;
    const de = esta.de;
    const levar = [];
    for (let i = 0; i < esta.itens.length; i++) {
      const ei = esta.itens[i];
      if (ei.rascunho) continue;   // o rascunho desta versão vale mais
      const r = lerJson(esta.storage, chaveItem(de, ei.item.numero));
      if (!r || !r.v) continue;
      const f = formDoRascunho(ei.item, r.v);
      const e = entradaDoForm(ei.item, f).entrada;
      if (e && mesmaResposta(e, ei.servidor)) continue;   // já chegou (foi copiado para esta versão)
      // guarda como o item estava quando a oferta foi montada: se o vendedor mexer nele (ou enviar)
      // nesta versão antes de tocar em Levar, o que ele fez aqui vale mais que o rascunho antigo
      levar.push({ ei: ei, form: f, rev: ei.rev, antes: JSON.stringify(ei.form) });
    }
    let geraisLevar = null;
    let geraisAntes = null;
    const g = esta.gerais;
    if (!g.rascunho) {
      const rg = lerJson(esta.storage, chaveGerais(de));
      if (rg && rg.v) {
        const f = formDoRascunhoGerais(rg.v);
        const x = geraisDoForm(f, g.hoje);
        if (!(x.gerais && mesmosGerais(x.gerais, g.servidor))) {
          geraisLevar = f;
          geraisAntes = { rev: g.rev, form: JSON.stringify(g.form) };
        }
      }
    }
    if (!levar.length && !geraisLevar) return null;
    const n = levar.length;
    let texto;
    if (n === 0) texto = 'Levar as condições que você ainda não enviou';
    else texto = 'Levar ' + (n === 1 ? 'o preço' : 'os ' + n + ' preços') + ' que você ainda não enviou' + (geraisLevar ? ' e as condições' : '');
    const caixa = el('section', { classe: 'cartao levar', id: 'levar' });
    caixa.appendChild(el('p', { texto: 'Você tinha preenchido a versão anterior e não chegou a enviar tudo.' }));
    const b = el('button', { type: 'button', classe: 'botao', id: 'levar-botao', texto: texto });
    b.addEventListener('click', function () {
      // confere de novo na hora do toque: o que o vendedor digitou, confirmou ou enviou nesta versão
      // depois de a oferta aparecer nunca é trocado pelo rascunho da versão anterior
      let levados = 0;
      let mantidos = 0;
      for (let i = 0; i < levar.length; i++) {
        const ei = levar[i].ei;
        const f = levar[i].form;
        apagarChave(esta.storage, chaveItem(de, ei.item.numero));
        const e = entradaDoForm(ei.item, f).entrada;
        if (ei.rascunho || ei.rev !== levar[i].rev || JSON.stringify(ei.form) !== levar[i].antes ||
            (e && mesmaResposta(e, ei.servidor))) {
          mantidos++;
          continue;
        }
        ei.form = f;
        ei.form.confirmado = false;
        ei.rascunho = { rev: ei.rev };
        salvarItem(ei);
        preencherItem(ei);
        sincronizarItem(ei);
        levados++;
      }
      if (geraisLevar) {
        const x = geraisDoForm(geraisLevar, g.hoje);
        if (g.rascunho || g.rev !== geraisAntes.rev || JSON.stringify(g.form) !== geraisAntes.form ||
            (x.gerais && mesmosGerais(x.gerais, g.servidor))) {
          mantidos++;
        } else {
          g.form = geraisLevar;
          g.rascunho = { rev: g.rev };
          salvarGerais(g);
          preencherGerais(g);
          sincronizarGerais(g);
          levados++;
        }
      }
      apagarChave(esta.storage, chaveGerais(de));
      apagarChave(esta.storage, chaveEnvio(de));
      limpar(caixa);
      let aviso;
      if (!levados) aviso = 'Nada foi trocado: você já preencheu esses itens nesta versão.';
      else if (mantidos) aviso = 'Pronto. O que você já tinha mexido nesta versão ficou como estava. Confira os preços antes de tocar em ENVIAR.';
      else aviso = 'Pronto. Confira os preços antes de tocar em ENVIAR.';
      caixa.appendChild(el('p', { classe: 'aviso', role: 'status', texto: aviso }));
      atualizarGeral();
    });
    caixa.appendChild(b);
    caixa.appendChild(el('p', { classe: 'dica', texto: 'Só os itens que continuam nesta versão, com o mesmo número. Confira antes de enviar.' }));
    return caixa;
  }

  // --- cartão do item

  function campoTexto(id, props) {
    return el('input', Object.assign({ type: 'text', autocomplete: 'off', id: id }, props || {}));
  }

  function montarItem(ei) {
    const it = ei.item;
    const n = it.numero;
    const pre = 'item-' + n + '-';
    const v = {};
    ei.view = v;
    v.raiz = el('section', { classe: 'cartao item', id: 'item-' + n, 'data-numero': n, 'aria-labelledby': pre + 'nome' });
    const cab = el('div', { classe: 'item-cabecalho' });
    cab.appendChild(el('h2', { classe: 'item-nome', id: pre + 'nome' }, [el('span', { classe: 'item-num', texto: n + '.' }), ' ' + it.nome]));
    v.situacao = el('span', { classe: 'situacao', id: pre + 'situacao' });
    cab.appendChild(v.situacao);
    v.raiz.appendChild(cab);
    // nota do Ivan (ajuste Foozi 3): logo abaixo do nome, sempre como texto; sem nota, nada
    const notaIvan = typeof it.nota === 'string' ? limparTexto(it.nota) : null;
    if (notaIvan) v.raiz.appendChild(el('p', { classe: 'item-obs', id: pre + 'nota', texto: notaIvan }));
    const ultimaNota = textoUltimaNota(it);
    if (ultimaNota) v.raiz.appendChild(el('p', { classe: 'item-nota', texto: ultimaNota }));
    v.raiz.appendChild(el('p', { classe: 'item-qtd', texto: textoQuantidade(it) }));

    // preço, base e conta
    v.blocoPreco = el('div', { classe: 'bloco-preco' });
    v.preco = campoTexto(pre + 'preco', { inputmode: 'decimal', classe: 'campo-preco', 'aria-describedby': pre + 'valor ' + pre + 'conta', enterkeyhint: 'done' });
    v.valor = el('p', { classe: 'valor-grande', id: pre + 'valor' });
    v.blocoPreco.appendChild(el('label', { classe: 'rotulo', for: pre + 'preco', texto: 'Preço (R$)' }));
    v.blocoPreco.appendChild(el('div', { classe: 'linha-preco' }, [v.preco, v.valor]));
    v.blocoPreco.appendChild(el('p', { classe: 'rotulo', id: pre + 'base-rotulo', texto: 'Esse preço é de' }));
    v.btUnidade = el('button', { type: 'button', classe: 'opcao', 'aria-pressed': 'false', id: pre + 'base-unidade' });
    v.btEmb = el('button', { type: 'button', classe: 'opcao', 'aria-pressed': 'false', id: pre + 'base-emb' });
    v.emb = campoTexto(pre + 'emb', { inputmode: 'decimal', classe: 'campo-curto' });
    v.embSufixo = el('span', { classe: 'sufixo' });
    v.blocoPreco.appendChild(el('div', { classe: 'opcoes', role: 'group', 'aria-labelledby': pre + 'base-rotulo' }, [
      v.btUnidade, el('span', { classe: 'opcao-emb' }, [v.btEmb, v.emb, v.embSufixo])
    ]));
    v.conta = el('p', { classe: 'conta', id: pre + 'conta' });
    v.blocoPreco.appendChild(v.conta);
    v.raiz.appendChild(v.blocoPreco);

    v.naoTemTexto = el('p', { classe: 'nao-tem-texto', texto: 'Marcado: não tenho este item.', hidden: true });
    v.raiz.appendChild(v.naoTemTexto);

    // avisos ("Confira"), conflito e erro
    v.confira = el('div', { classe: 'confira', hidden: true });
    v.conflito = el('div', { classe: 'conflito', hidden: true });
    v.erro = el('p', { classe: 'erro-item', role: 'alert', hidden: true });
    v.raiz.appendChild(v.confira);
    v.raiz.appendChild(v.conflito);
    v.raiz.appendChild(v.erro);

    // ações: Não tenho · Mais opções
    v.btNaoTem = el('button', { type: 'button', classe: 'opcao nao-tem', 'aria-pressed': 'false', id: pre + 'nao-tem', texto: 'Não tenho' });
    v.btMais = el('button', { type: 'button', classe: 'link', 'aria-expanded': 'false', 'aria-controls': pre + 'mais', id: pre + 'mais-botao', 'data-livre': '1', texto: 'Mais opções' });
    v.raiz.appendChild(el('div', { classe: 'acoes' }, [v.btNaoTem, v.btMais]));

    v.mais = el('div', { classe: 'mais', id: pre + 'mais', hidden: true });
    const suf = sufixoQtd(it);
    v.tenhoSo = campoTexto(pre + 'tenho-so', { inputmode: 'decimal', classe: 'campo-curto' });
    v.linhaTenhoSo = el('p', { classe: 'linha-campo' }, [el('label', { for: pre + 'tenho-so', texto: 'Tenho só' }), v.tenhoSo, el('span', { classe: 'sufixo', texto: suf })]);
    v.similarDesc = campoTexto(pre + 'similar', { maxlength: '200', classe: 'campo-medio' });
    v.similarPreco = campoTexto(pre + 'similar-preco', { inputmode: 'decimal', classe: 'campo-curto', 'aria-label': 'Preço do similar (R$)' });
    v.linhaSimilar = el('p', { classe: 'linha-campo' }, [el('label', { for: pre + 'similar', texto: 'Tenho similar:' }), v.similarDesc, el('span', { classe: 'sufixo', texto: 'a R$' }), v.similarPreco]);
    v.aPartir = campoTexto(pre + 'a-partir', { inputmode: 'decimal', classe: 'campo-curto' });
    v.linhaAPartir = el('p', { classe: 'linha-campo' }, [el('label', { for: pre + 'a-partir', texto: 'Esse preço vale a partir de' }), v.aPartir, el('span', { classe: 'sufixo', texto: suf })]);
    v.marca = campoTexto(pre + 'marca', { maxlength: String(MAX_MARCA), classe: 'campo-medio', autocapitalize: 'words' });
    v.linhaMarca = el('p', { classe: 'linha-campo' }, [el('label', { for: pre + 'marca', texto: 'Marca:' }), v.marca, el('span', { classe: 'sufixo', texto: '(opcional)' })]);
    v.mais.appendChild(v.linhaTenhoSo);
    v.mais.appendChild(v.linhaSimilar);
    v.mais.appendChild(v.linhaAPartir);
    v.mais.appendChild(v.linhaMarca);
    if (it.unidade === 'kg') {
      v.btModo = el('button', { type: 'button', classe: 'link', id: pre + 'modo' });
      v.mais.appendChild(el('p', { classe: 'linha-campo' }, [v.btModo]));
    }
    v.raiz.appendChild(v.mais);

    // eventos
    v.preco.addEventListener('input', function () { ei.form.preco = v.preco.value; editouItem(ei, true); });
    v.btUnidade.addEventListener('click', function () { ei.form.base = 'unidade'; editouItem(ei, true); });
    v.btEmb.addEventListener('click', function () { ei.form.base = 'embalagem'; editouItem(ei, true); try { v.emb.focus(); } catch (e) { /* nada */ } });
    v.emb.addEventListener('input', function () {
      ei.form.emb = v.emb.value;
      if (preenchido(ei.form.emb)) ei.form.base = 'embalagem';
      editouItem(ei, true);
    });
    v.btNaoTem.addEventListener('click', function () { ei.form.nao_tem = !ei.form.nao_tem; editouItem(ei, true); });
    v.btMais.addEventListener('click', function () { ei.maisAberto = !ei.maisAberto; sincronizarItem(ei); });
    v.tenhoSo.addEventListener('input', function () { ei.form.tenho_so = v.tenhoSo.value; editouItem(ei, false); });
    v.similarDesc.addEventListener('input', function () { ei.form.similar_desc = v.similarDesc.value; editouItem(ei, false); });
    v.similarPreco.addEventListener('input', function () { ei.form.similar_preco = v.similarPreco.value; editouItem(ei, false); });
    v.aPartir.addEventListener('input', function () { ei.form.a_partir_de = v.aPartir.value; editouItem(ei, false); });
    v.marca.addEventListener('input', function () { ei.form.marca = v.marca.value; editouItem(ei, false); });
    if (v.btModo) {
      v.btModo.addEventListener('click', function () {
        // trocar kg ↔ litro muda o sentido da embalagem (g ↔ ml): começa a escolha de novo
        ei.form.modo = modoValido(it, ei.form.modo) === 'litro' ? 'kg' : 'litro';
        ei.form.base = null;
        ei.form.emb = '';
        editouItem(ei, true);
      });
    }
    const f = ei.form;
    ei.maisAberto = preenchido(f.tenho_so) || preenchido(f.similar_desc) || preenchido(f.similar_preco) ||
      preenchido(f.a_partir_de) || preenchido(f.marca) || modoValido(it, f.modo) !== modoPadrao(it);
    preencherItem(ei);
    return v;
  }

  function preencherItem(ei) {
    const v = ei.view;
    if (!v) return;
    valorCampo(v.preco, ei.form.preco);
    valorCampo(v.emb, ei.form.emb);
    valorCampo(v.tenhoSo, ei.form.tenho_so);
    valorCampo(v.similarDesc, ei.form.similar_desc);
    valorCampo(v.similarPreco, ei.form.similar_preco);
    valorCampo(v.aPartir, ei.form.a_partir_de);
    valorCampo(v.marca, ei.form.marca);
  }

  function textoCurto(r) {
    if (!r || r.estado === 'sem_resposta') return 'sem preço';
    if (r.estado === 'nao_tem') return '"Não tenho"';
    return formatarReais(r.preco_digitado);
  }

  function textoCurtoForm(ei) {
    if (ei.form.nao_tem) return '"Não tenho"';
    const p = lerDinheiro(ei.form.preco);
    return p === null ? '' : formatarReais(p);
  }

  function sincronizarItem(ei) {
    const v = ei.view;
    if (!v) return;
    const it = ei.item;
    const f = ei.form;
    const modo = modoValido(it, f.modo);
    const nt = !!f.nao_tem;
    v.raiz.classList.toggle('marcado-nao-tem', nt);
    marcar(v.btNaoTem, nt);
    v.blocoPreco.hidden = nt;
    v.naoTemTexto.hidden = !nt;
    v.linhaTenhoSo.hidden = nt;
    v.linhaAPartir.hidden = nt;
    v.linhaMarca.hidden = nt;
    v.mais.hidden = !ei.maisAberto;
    v.btMais.setAttribute('aria-expanded', ei.maisAberto ? 'true' : 'false');
    v.btMais.textContent = ei.maisAberto ? 'Menos opções' : 'Mais opções';

    const rot = rotulosBase(it, modo);
    v.btUnidade.textContent = rot.unidade;
    v.btEmb.textContent = rot.emb;
    v.embSufixo.textContent = rot.sufixo;
    v.emb.setAttribute('aria-label', rot.ajuda);
    marcar(v.btUnidade, f.base === 'unidade');
    marcar(v.btEmb, f.base === 'embalagem');
    if (v.btModo) v.btModo.textContent = modo === 'litro' ? 'Vendo por kg' : 'Vendo por litro';

    // valor interpretado, grande, e a conta ao vivo
    const p = lerNumero(f.preco);
    let valor = '';
    if (preenchido(f.preco)) {
      if (p === null) valor = 'Não entendi o preço';
      else if (p <= 0) valor = 'O preço precisa ser maior que zero';
      else if (p > 1000000) valor = 'Valor alto demais';
      else if (!duasCasas(p)) valor = 'Use até 2 casas depois da vírgula';
      else valor = formatarReais(p);
    }
    v.valor.textContent = valor;
    v.conta.textContent = contaAoVivo(it, f) || '';

    // avisos do banco para o valor gravado (somem quando há edição por cima, inclusive "Está certo")
    const r = ei.servidor || RESPOSTA_VAZIA;
    const avisos = !ei.rascunho && !ei.conflito && r.estado === 'tem' && Array.isArray(r.avisos_vendedor) ? r.avisos_vendedor : [];
    const chaveConfira = avisos.join(',') + '|' + ei.rev;
    if (v.chaveConfira !== chaveConfira) {
      v.chaveConfira = chaveConfira;
      limpar(v.confira);
      const textos = [];
      for (let i = 0; i < avisos.length; i++) {
        const t = textoAviso(avisos[i], it, r);
        if (t) textos.push(t);
      }
      if (textos.length) {
        v.confira.appendChild(el('p', { classe: 'confira-titulo', texto: 'Confira:' }));
        for (let i = 0; i < textos.length; i++) v.confira.appendChild(el('p', { classe: 'confira-texto', texto: textos[i] }));
        const b = el('button', { type: 'button', classe: 'botao secundario', id: 'item-' + it.numero + '-esta-certo', texto: 'Está certo' });
        b.addEventListener('click', function () { estaCerto(ei); });
        v.confira.appendChild(b);
      }
      v.confira.hidden = textos.length === 0;
    }

    // conflito: o banco tem outro valor, gravado depois que a página abriu
    limpar(v.conflito);
    if (ei.conflito) {
      const atual = textoCurto(ei.servidor);
      const meu = textoCurtoForm(ei);
      v.conflito.appendChild(el('p', { texto: 'Este item foi alterado depois que você abriu: ' + atual + '.' }));
      const manter = el('button', { type: 'button', classe: 'botao', id: 'item-' + it.numero + '-manter', texto: 'Manter o meu' + (meu ? ' ' + meu : '') });
      const ficar = el('button', { type: 'button', classe: 'botao secundario', id: 'item-' + it.numero + '-ficar', texto: 'Ficar com ' + atual });
      manter.addEventListener('click', function () { manterMeu(ei); });
      ficar.addEventListener('click', function () { ficarComAtual(ei); });
      v.conflito.appendChild(el('div', { classe: 'acoes' }, [manter, ficar]));
    }
    v.conflito.hidden = !ei.conflito;

    // erro: o local (depois de um ENVIAR) ou o que o banco devolveu
    let erro = null;
    if (ei.rascunho && ei.mostrarErro) {
      const x = entradaDoForm(it, f);
      if (x.erro) erro = textoErroLocal(x.erro, it, f);
    }
    if (!erro && ei.erroServidor) erro = TEXTOS_ERRO_ITEM[ei.erroServidor] || TEXTOS_ERRO_ITEM.valor_invalido;
    if (v.erro.textContent !== (erro || '')) v.erro.textContent = erro || '';
    v.erro.hidden = !erro;
    v.raiz.classList.toggle('com-erro', !!erro);

    // situação do item
    let situacao = '';
    let classe = 'situacao';
    if (ei.rascunho) {
      situacao = 'Ainda não enviado';
      classe += ' pendente';
    } else if (r.estado === 'tem' || r.estado === 'nao_tem') {
      situacao = 'Recebido';
      classe += ' recebido';
    }
    v.situacao.textContent = situacao;
    v.situacao.className = classe;
  }

  /** Prévia (&p=1) é só leitura (D14) e a cotação fechada também: nenhuma edição vale. */
  function somenteLeitura() {
    return !P || P.fechado || P.previa;
  }

  function editouItem(ei, mudouValor) {
    if (somenteLeitura()) return;
    if (mudouValor) {
      // mudou preço/base/embalagem: o "Está certo" antigo não vale para o valor novo
      const e = entradaDoForm(ei.item, Object.assign({}, ei.form, { confirmado: false })).entrada;
      ei.form.confirmado = e && mesmaResposta(e, ei.servidor, true) ? !!(ei.servidor && ei.servidor.confirmado_pelo_vendedor) : false;
    }
    ei.erroServidor = null;
    salvarItem(ei);
    sincronizarItem(ei);
    atualizarGeral();
  }

  /** Grava ou apaga o rascunho do item: igual ao que o banco tem = nada a enviar. */
  function salvarItem(ei) {
    const k = chaveItem(P.h, ei.item.numero);
    const e = entradaDoForm(ei.item, ei.form).entrada;
    if (e && mesmaResposta(e, ei.servidor)) {
      if (ei.rascunho) {
        ei.rascunho = null;
        ei.conflito = false;
        apagarChave(P.storage, k);
      }
      return;
    }
    if (!ei.rascunho) ei.rascunho = { rev: ei.rev };
    // "e" = a entrada já validada (null se incompleta): depois do fechamento, sem os dados do item, é com ela que
    // a página sabe se o rascunho chegou (contrato 9.5)
    gravarJson(P.storage, k, { t: agoraMs(), rev: ei.rascunho.rev, v: ei.form, e: e || null });
  }

  function descartarRascunho(ei) {
    ei.rascunho = null;
    ei.conflito = false;
    apagarChave(P.storage, chaveItem(P.h, ei.item.numero));
  }

  function estaCerto(ei) {
    if (somenteLeitura()) return;
    ei.form = formDaResposta(ei.item, ei.servidor);
    ei.form.confirmado = true;
    salvarItem(ei);
    preencherItem(ei);
    sincronizarItem(ei);
    atualizarGeral();
  }

  function manterMeu(ei) {
    if (somenteLeitura() || !ei.rascunho) return;
    ei.conflito = false;
    ei.rascunho.rev = ei.rev;
    salvarItem(ei);
    sincronizarItem(ei);
    atualizarGeral();
  }

  function ficarComAtual(ei) {
    if (somenteLeitura()) return;
    descartarRascunho(ei);
    ei.form = formDaResposta(ei.item, ei.servidor);
    preencherItem(ei);
    sincronizarItem(ei);
    atualizarGeral();
  }

  // --- condições gerais (uma vez, no fim)

  function botaoOpcao(id, texto) {
    return el('button', { type: 'button', classe: 'opcao', 'aria-pressed': 'false', id: id, texto: texto });
  }

  // condições com erro próprio, na ordem da tela; o id do erro é "gerais-erro-<sufixo>"
  const CAMPOS_CONDICAO = ['pagamento', 'validade', 'pedido_minimo', 'frete', 'entrega', 'observacao'];
  const SUFIXO_ERRO = { pagamento: 'pagamento', validade: 'validade', pedido_minimo: 'minimo', frete: 'frete', entrega: 'entrega', observacao: 'observacao' };

  function erroDoCampo(campo) {
    return el('p', { classe: 'erro-item erro-campo', id: 'gerais-erro-' + SUFIXO_ERRO[campo], role: 'alert', hidden: true });
  }

  function montarGerais(g) {
    const v = {};
    g.view = v;
    v.grupos = {};     // o que fica destacado quando o aviso leva até a condição
    v.entradas = {};   // o campo onde se digita o que falta (null: escolhe-se num botão)
    v.erros = {};      // o erro de cada condição, logo abaixo dela
    for (let i = 0; i < CAMPOS_CONDICAO.length; i++) v.erros[CAMPOS_CONDICAO[i]] = erroDoCampo(CAMPOS_CONDICAO[i]);
    v.raiz = el('section', { classe: 'cartao gerais', id: 'gerais', 'aria-labelledby': 'gerais-titulo' });
    const cab = el('div', { classe: 'item-cabecalho' });
    cab.appendChild(el('h2', { classe: 'item-nome', id: 'gerais-titulo', texto: 'Condições (valem para todos os itens)' }));
    v.situacao = el('span', { classe: 'situacao', id: 'gerais-situacao' });
    cab.appendChild(v.situacao);
    v.raiz.appendChild(cab);
    // recusa do banco que não é de um campo só: no alto do cartão, onde se chega rolando
    v.erro = el('p', { classe: 'erro-item', id: 'gerais-erro', role: 'alert', hidden: true });
    v.raiz.appendChild(v.erro);

    // pagamento
    v.pagBoleto = botaoOpcao('gerais-pag-boleto', 'Boleto');
    v.pagDias = campoTexto('gerais-pag-dias', {
      inputmode: 'numeric', classe: 'campo-curto', 'aria-label': 'Dias do boleto', 'aria-describedby': 'gerais-erro-pagamento'
    });
    v.pagPix = botaoOpcao('gerais-pag-pix', 'Pix');
    v.pagVista = botaoOpcao('gerais-pag-vista', 'À vista');
    v.pagOutro = botaoOpcao('gerais-pag-outro', '');
    v.raiz.appendChild(el('p', { classe: 'rotulo', id: 'gerais-pag-rotulo', texto: 'Pagamento' }));
    v.grupos.pagamento = el('div', { classe: 'opcoes', id: 'gerais-pag-opcoes', role: 'group', 'aria-labelledby': 'gerais-pag-rotulo' }, [
      el('span', { classe: 'opcao-emb' }, [v.pagBoleto, v.pagDias, el('span', { classe: 'sufixo', texto: 'dias' })]),
      v.pagPix, v.pagVista, v.pagOutro
    ]);
    v.entradas.pagamento = v.pagDias;
    v.raiz.appendChild(v.grupos.pagamento);
    v.raiz.appendChild(v.erros.pagamento);

    // validade, com as datas absolutas que o banco manda (refeitas se o dia virar com a página aberta)
    v.raiz.appendChild(el('p', { classe: 'rotulo', id: 'gerais-val-rotulo', texto: 'Preço válido até' }));
    v.grupoVal = el('div', { classe: 'opcoes', id: 'gerais-val-opcoes', role: 'group', 'aria-labelledby': 'gerais-val-rotulo' });
    v.valBotoes = [];
    v.valOutra = botaoOpcao('gerais-val-outra', 'outra data');
    v.valData = el('input', {
      type: 'date', classe: 'campo-data', id: 'gerais-val-data', 'aria-label': 'Outra data de validade', 'aria-describedby': 'gerais-erro-validade'
    });
    v.valOutraCaixa = el('span', { classe: 'opcao-emb' }, [v.valOutra, v.valData]);
    v.grupoVal.appendChild(v.valOutraCaixa);
    montarBotoesValidade(g);
    v.grupos.validade = v.grupoVal;
    v.entradas.validade = null;   // a data se escolhe num botão ou no calendário: o aviso só rola até lá
    v.raiz.appendChild(v.grupoVal);
    v.raiz.appendChild(v.erros.validade);

    // pedido mínimo e frete
    v.minSem = botaoOpcao('gerais-min-sem', 'Sem mínimo');
    v.minValorBt = botaoOpcao('gerais-min-valor-bt', 'Mínimo R$');
    v.minValor = campoTexto('gerais-min-valor', {
      inputmode: 'decimal', classe: 'campo-curto', 'aria-label': 'Pedido mínimo (R$)', 'aria-describedby': 'gerais-erro-minimo'
    });
    v.raiz.appendChild(el('p', { classe: 'rotulo', id: 'gerais-min-rotulo', texto: 'Pedido mínimo' }));
    v.grupos.pedido_minimo = el('div', { classe: 'opcoes', id: 'gerais-min-opcoes', role: 'group', 'aria-labelledby': 'gerais-min-rotulo' }, [
      v.minSem, el('span', { classe: 'opcao-emb' }, [v.minValorBt, v.minValor])
    ]);
    v.entradas.pedido_minimo = v.minValor;
    v.raiz.appendChild(v.grupos.pedido_minimo);
    v.raiz.appendChild(v.erros.pedido_minimo);
    v.frete = campoTexto('gerais-frete', { inputmode: 'decimal', classe: 'campo-curto', 'aria-describedby': 'gerais-erro-frete' });
    v.grupos.frete = el('p', { classe: 'linha-campo', id: 'gerais-frete-linha' }, [el('label', { for: 'gerais-frete', texto: 'Frete R$' }), v.frete]);
    v.entradas.frete = v.frete;
    v.raiz.appendChild(v.grupos.frete);
    v.raiz.appendChild(v.erros.frete);

    // horário em que a Spazio recebe mercadoria (ajuste Foozi 5): constante do config.js, fora da mensagem
    const recebe = textoRecebimento();
    if (recebe) v.raiz.appendChild(el('p', { classe: 'recebimento', id: 'gerais-recebimento', texto: recebe }));

    // entrega
    v.entSeguinte = botaoOpcao('gerais-ent-seguinte', 'Dia seguinte');
    v.ent2 = botaoOpcao('gerais-ent-2dias', '2 dias');
    v.entOutraBt = botaoOpcao('gerais-ent-outra-bt', 'Outra data');
    v.entOutra = campoTexto('gerais-ent-outra', {
      maxlength: '200', classe: 'campo-medio', 'aria-label': 'Outra data de entrega', 'aria-describedby': 'gerais-erro-entrega'
    });
    v.entRetirar = botaoOpcao('gerais-ent-retirar', 'Retirar na loja');
    v.raiz.appendChild(el('p', { classe: 'rotulo', id: 'gerais-ent-rotulo', texto: 'Se eu fechar, entrego em' }));
    v.grupos.entrega = el('div', { classe: 'opcoes', id: 'gerais-ent-opcoes', role: 'group', 'aria-labelledby': 'gerais-ent-rotulo' }, [
      v.entSeguinte, v.ent2, el('span', { classe: 'opcao-emb' }, [v.entOutraBt, v.entOutra]), v.entRetirar
    ]);
    v.entradas.entrega = v.entOutra;
    v.raiz.appendChild(v.grupos.entrega);
    v.raiz.appendChild(v.erros.entrega);

    // observação
    v.obs = el('textarea', { id: 'gerais-obs', classe: 'campo-obs', rows: '3', maxlength: '1000', 'aria-describedby': 'gerais-erro-observacao' });
    v.raiz.appendChild(el('label', { classe: 'rotulo', for: 'gerais-obs', texto: 'Observação' }));
    v.grupos.observacao = v.obs;
    v.entradas.observacao = v.obs;
    v.raiz.appendChild(v.obs);
    v.raiz.appendChild(v.erros.observacao);

    v.conflito = el('div', { classe: 'conflito', hidden: true });
    v.raiz.appendChild(v.conflito);

    // eventos
    v.pagBoleto.addEventListener('click', function () { g.form.pag = 'boleto'; editouGerais(g); });
    v.pagDias.addEventListener('input', function () { g.form.pag_dias = v.pagDias.value; if (preenchido(v.pagDias.value)) g.form.pag = 'boleto'; editouGerais(g); });
    v.pagPix.addEventListener('click', function () { g.form.pag = 'pix'; editouGerais(g); });
    v.pagVista.addEventListener('click', function () { g.form.pag = 'vista'; editouGerais(g); });
    v.pagOutro.addEventListener('click', function () { if (preenchido(g.form.pag_outro)) { g.form.pag = 'outro'; editouGerais(g); } });
    v.valOutra.addEventListener('click', function () { g.form.validade_outra = true; g.form.validade = lerDataDigitada(v.valData.value, g.hoje); editouGerais(g); });
    const aoData = function () {
      g.form.validade_outra = true;
      g.form.validade = lerDataDigitada(v.valData.value, g.hoje);
      g.dataInvalida = preenchido(v.valData.value) && !g.form.validade;
      editouGerais(g);
    };
    v.valData.addEventListener('input', aoData);
    v.valData.addEventListener('change', aoData);
    v.minSem.addEventListener('click', function () { g.form.minimo = 'sem'; editouGerais(g); });
    v.minValorBt.addEventListener('click', function () { g.form.minimo = 'valor'; editouGerais(g); });
    v.minValor.addEventListener('input', function () { g.form.minimo_valor = v.minValor.value; g.form.minimo = 'valor'; editouGerais(g); });
    v.frete.addEventListener('input', function () { g.form.frete = v.frete.value; editouGerais(g); });
    v.entSeguinte.addEventListener('click', function () { g.form.entrega = 'seguinte'; editouGerais(g); });
    v.ent2.addEventListener('click', function () { g.form.entrega = '2dias'; editouGerais(g); });
    v.entOutraBt.addEventListener('click', function () { g.form.entrega = 'outra'; editouGerais(g); });
    v.entOutra.addEventListener('input', function () { g.form.entrega_outra = v.entOutra.value; g.form.entrega = 'outra'; editouGerais(g); });
    v.entRetirar.addEventListener('click', function () { g.form.entrega = 'retirar'; editouGerais(g); });
    v.obs.addEventListener('input', function () { g.form.observacao = v.obs.value; editouGerais(g); });

    preencherGerais(g);
    return v.raiz;
  }

  /** Botões de "Preço válido até" (g.opcoes, antes de "outra data") e os limites do calendário (hoje a hoje + 366, D30). */
  function montarBotoesValidade(g) {
    const v = g.view;
    for (let i = 0; i < v.valBotoes.length; i++) v.grupoVal.removeChild(v.valBotoes[i].botao);
    v.valBotoes = [];
    // na prévia e depois do fechamento os campos estão travados: os botões refeitos também
    const travado = !!(P && (P.previa || P.fechado));
    for (let i = 0; i < g.opcoes.length; i++) {
      const op = g.opcoes[i];
      if (!op || typeof op.data !== 'string' || !dataValida(op.data)) continue;
      const b = botaoOpcao('gerais-val-' + op.data, op.rotulo || op.data);
      b.addEventListener('click', function () { g.form.validade = op.data; g.form.validade_outra = false; editouGerais(g); });
      if (travado) b.disabled = true;
      v.grupoVal.insertBefore(b, v.valOutraCaixa);
      v.valBotoes.push({ botao: b, data: op.data });
    }
    if (g.hoje) {
      v.valData.setAttribute('min', g.hoje);
      v.valData.setAttribute('max', somarDias(g.hoje, 366));
    }
  }

  /** A validade aparece em "outra data" quando foi digitada ou quando não é mais um dos botões (o "hoje" de ontem). */
  function validadeEmOutra(g) {
    const f = g.form;
    if (f.validade_outra) return true;
    if (!f.validade) return false;
    for (let i = 0; i < g.opcoes.length; i++) if (g.opcoes[i] && g.opcoes[i].data === f.validade) return false;
    return true;
  }

  function validadePassou(f, hoje) {
    return !!(f && f.validade && hoje && f.validade < hoje);
  }

  function preencherGerais(g) {
    const v = g.view;
    if (!v) return;
    valorCampo(v.pagDias, g.form.pag_dias);
    valorCampo(v.minValor, g.form.minimo_valor);
    valorCampo(v.frete, g.form.frete);
    valorCampo(v.entOutra, g.form.entrega_outra);
    valorCampo(v.obs, g.form.observacao);
    if (g.form.validade && validadeEmOutra(g)) valorCampo(v.valData, g.form.validade);
  }

  function sincronizarGerais(g) {
    const v = g.view;
    if (!v) return;
    const f = g.form;
    marcar(v.pagBoleto, f.pag === 'boleto');
    marcar(v.pagPix, f.pag === 'pix');
    marcar(v.pagVista, f.pag === 'vista');
    v.pagOutro.textContent = 'Outro: ' + (f.pag_outro || '');
    v.pagOutro.hidden = !preenchido(f.pag_outro);
    marcar(v.pagOutro, f.pag === 'outro');
    const outra = validadeEmOutra(g);
    for (let i = 0; i < v.valBotoes.length; i++) marcar(v.valBotoes[i].botao, !outra && f.validade === v.valBotoes[i].data);
    marcar(v.valOutra, outra);
    marcar(v.minSem, f.minimo === 'sem');
    marcar(v.minValorBt, f.minimo === 'valor');
    marcar(v.entSeguinte, f.entrega === 'seguinte');
    marcar(v.ent2, f.entrega === '2dias');
    marcar(v.entOutraBt, f.entrega === 'outra');
    marcar(v.entRetirar, f.entrega === 'retirar');

    limpar(v.conflito);
    if (g.conflito) {
      v.conflito.appendChild(el('p', { texto: 'As condições foram alteradas depois que você abriu: ' + textoGerais(g.servidor) + '.' }));
      const manter = el('button', { type: 'button', classe: 'botao', id: 'gerais-manter', texto: 'Manter as minhas' });
      const ficar = el('button', { type: 'button', classe: 'botao secundario', id: 'gerais-ficar', texto: 'Ficar com as atuais' });
      manter.addEventListener('click', function () {
        if (somenteLeitura() || !g.rascunho) return;
        g.conflito = false;
        g.rascunho.rev = g.rev;
        salvarGerais(g);
        sincronizarGerais(g);
        atualizarGeral();
      });
      ficar.addEventListener('click', function () {
        if (somenteLeitura()) return;
        descartarRascunhoGerais(g);
        g.form = formDosGerais(g.servidor, g.opcoes);
        preencherGerais(g);
        sincronizarGerais(g);
        atualizarGeral();
      });
      v.conflito.appendChild(el('div', { classe: 'acoes' }, [manter, ficar]));
    }
    v.conflito.hidden = !g.conflito;

    // erros: cada um logo abaixo da sua condição (a recusa genérica do banco, no alto do cartão)
    const erros = errosDasCondicoes(g);
    let algum = !!erros.geral;
    for (let i = 0; i < CAMPOS_CONDICAO.length; i++) {
      const campo = CAMPOS_CONDICAO[i];
      const t = erros.campos[campo] || '';
      const n = v.erros[campo];
      if (n.textContent !== t) n.textContent = t;
      n.hidden = !t;
      if (t) algum = true;
      const entrada = v.entradas[campo];
      if (entrada) {
        if (t) entrada.setAttribute('aria-invalid', 'true');
        else entrada.removeAttribute('aria-invalid');
      }
      // o destaque (o aviso do rodapé levou até aqui) fica até a condição ser resolvida
      if (!t && g.destaque === campo) g.destaque = null;
      v.grupos[campo].classList.toggle('destaque', !!t && g.destaque === campo);
    }
    if (v.erro.textContent !== (erros.geral || '')) v.erro.textContent = erros.geral || '';
    v.erro.hidden = !erros.geral;
    v.raiz.classList.toggle('com-erro', algum);

    v.situacao.textContent = g.rascunho ? 'Ainda não enviado' : (g.servidor && !mesmosGerais(g.servidor, GERAIS_VAZIAS) ? 'Recebido' : '');
    v.situacao.className = 'situacao' + (g.rascunho ? ' pendente' : (v.situacao.textContent ? ' recebido' : ''));
  }

  /**
   * Os erros das condições a mostrar: { campos: {campo: texto}, geral }. Os locais aparecem depois de um ENVIAR
   * (mostrarErro); a data que não deu para ler aparece na hora; a recusa do banco, quando não há erro local.
   */
  function errosDasCondicoes(g) {
    const r = { campos: {}, geral: null };
    const f = g.form;
    if (g.dataInvalida) r.campos.validade = 'Não entendi a data de validade.';
    if (g.rascunho && g.mostrarErro) {
      const erros = analisarGerais(f, g.hoje).erros;
      for (let i = 0; i < erros.length; i++) {
        const e = erros[i];
        if (!r.campos[e.campo]) r.campos[e.campo] = TEXTOS_ERRO_CONDICAO[e.campo + ':' + e.motivo] || 'Confira esta condição.';
      }
    }
    if (g.erroServidor && !Object.keys(r.campos).length) {
      if (g.erroServidor === 'texto_invalido') r.geral = 'Algum texto das condições é inválido ou longo demais.';
      // o banco confere a validade com o dia de agora (D30): se ela já passou, a culpada é ela, não "algum valor"
      else if (validadePassou(f, diaLocalAgora(P) || g.hoje)) r.campos.validade = TEXTO_VALIDADE_PASSOU;
      else r.geral = 'Algum valor das condições está fora do esperado. Confira.';
    }
    return r;
  }

  /** O primeiro problema das condições que o vendedor precisa resolver (depois de um ENVIAR), ou null. */
  function problemaDasCondicoes(g) {
    if (!g || !g.rascunho || !g.mostrarErro || g.conflito) return null;
    return geraisDoForm(g.form, g.hoje).erro;
  }

  /**
   * Leva o vendedor à condição que falta: rola até o campo (ou até as opções, quando se escolhe num botão), destaca
   * e, com focar (toque no aviso), põe o cursor nele. Devolve false se não há o que completar.
   */
  function irParaCondicao(esta, focar) {
    const g = esta && esta.gerais;
    const e = problemaDasCondicoes(g);
    if (!e || !g.view) return false;
    const v = g.view;
    g.destaque = e.campo;
    sincronizarGerais(g);
    // o campo de digitar só quando o que falta é digitado nele (o "outro" pagamento veio do banco, sem campo)
    const entrada = e.campo === 'pagamento' && e.motivo === 'texto' ? null : v.entradas[e.campo];
    rolarAte(entrada || v.grupos[e.campo]);
    if (focar && entrada && !entrada.disabled) {
      try { entrada.focus({ preventScroll: true }); } catch (x) { entrada.focus(); }
    }
    return true;
  }

  function editouGerais(g) {
    if (somenteLeitura()) return;
    g.erroServidor = null;
    if (!g.form.validade_outra) g.dataInvalida = false;
    salvarGerais(g);
    sincronizarGerais(g);
    atualizarGeral();
  }

  function salvarGerais(g) {
    const k = chaveGerais(P.h);
    const x = geraisDoForm(g.form, g.hoje);
    if (x.gerais && mesmosGerais(x.gerais, g.servidor)) {
      if (g.rascunho) {
        g.rascunho = null;
        g.conflito = false;
        apagarChave(P.storage, k);
      }
      return;
    }
    if (!g.rascunho) g.rascunho = { rev: g.rev };
    gravarJson(P.storage, k, { t: agoraMs(), rev: g.rascunho.rev, v: g.form });
  }

  function descartarRascunhoGerais(g) {
    g.rascunho = null;
    g.conflito = false;
    // chegaram (ou o vendedor ficou com as atuais): os erros da próxima edição só depois de outro ENVIAR
    g.mostrarErro = false;
    g.destaque = null;
    apagarChave(P.storage, chaveGerais(P.h));
  }

  // --- rodapé, faixa vermelha e relógio

  function preenchidos(esta) {
    let n = 0;
    for (let i = 0; i < esta.itens.length; i++) {
      const f = esta.itens[i].form;
      if (f.nao_tem || preenchido(f.preco)) n++;
    }
    return n;
  }

  /** Todos os preços preenchidos já estão no banco (nenhum item à espera, nenhum envio sem confirmação)? */
  function precosNoBanco(esta) {
    if (esta.envio) return false;
    let algum = false;
    for (let i = 0; i < esta.itens.length; i++) {
      const ei = esta.itens[i];
      if (ei.rascunho) return false;
      const estado = ei.servidor && ei.servidor.estado;
      if (estado === 'tem' || estado === 'nao_tem') algum = true;
    }
    return algum;
  }

  /** "Preços enviados. Falta o prazo do boleto — toque aqui para completar" (ou null: nada a completar). */
  function avisoCondicao(esta) {
    const g = esta.gerais;
    const e = problemaDasCondicoes(g);
    if (!e) return null;
    let a = AVISOS_CONDICAO[e.campo + ':' + e.motivo] || ['Falta completar as condições', 'completar'];
    if (e.campo === 'validade' && e.motivo === 'sem_data' && g.dataInvalida) a = ['Não entendi a data de validade', 'corrigir'];
    return (precosNoBanco(esta) ? 'Preços enviados. ' : '') + a[0] + ' — toque aqui para ' + a[1];
  }

  function atualizarGeral() {
    const esta = P;
    if (!esta || esta.vista !== 'form') return;
    const total = esta.itens.length;
    esta.viewContador.textContent = preenchidos(esta) + ' de ' + total + ' preenchidos';
    const pend = !esta.previa && pendente(esta);
    // só falta o vendedor completar as condições: nada a mandar nem a confirmar, então nem faixa vermelha ("tentar
    // de novo" não resolve) nem "Ainda não enviado" (os preços chegaram) — quem fala é o aviso das condições.
    // Depois do fechamento não há mais o que completar: a faixa volta (o que não foi ficou só no celular)
    const m = montarEnvio(esta.itens, esta.gerais);
    const soCondicao = pend && !esta.fechado && !esta.envio && !m.p_itens.length && m.p_gerais === null &&
      !m.invalidos.length && m.geraisInvalidas && !conflitosAbertos(esta);
    const faixa = porId('faixa-pendente');
    faixa.hidden = !pend || soCondicao;
    faixa.disabled = esta.enviando || esta.aguardando;
    const status = porId('status');
    let st = '';
    let classe = 'status';
    if (esta.enviando) {
      st = 'Enviando…';
    } else if (esta.aguardando) {
      st = 'Aguardando para tentar de novo…';
    } else if (pend && !soCondicao) {
      st = 'Ainda não enviado.' + (esta.falhaRede ? ' Não consegui confirmar o envio. ' + TEXTO_WHATSAPP : '');
      classe += ' pendente';
    } else if (esta.recebidoEm) {
      st = 'Recebido às ' + esta.recebidoEm;
      classe += ' recebido';
    }
    status.textContent = st;
    status.className = classe;
    const completar = porId('completar');
    const aviso = esta.previa || esta.fechado || esta.enviando || esta.aguardando ? null : avisoCondicao(esta);
    if (completar.textContent !== (aviso || '')) completar.textContent = aviso || '';
    completar.hidden = !aviso;
    porId('pronto').hidden = pend || !esta.recebidoEm || esta.enviando;
    const msg = porId('mensagem');
    msg.textContent = esta.mensagem || '';
    msg.hidden = !esta.mensagem;
    const botao = porId('enviar');
    botao.disabled = esta.previa || esta.enviando || esta.aguardando || !pend || (esta.fechado && !esta.envio);
  }

  function segundosRestantes(esta) {
    return Number(esta.dados.segundos_para_fechar) - (agoraMs() - esta.aberturaMs) / 1000;
  }

  /**
   * O dia virou com a página aberta (a cotação chega seg à tarde, o vendedor abre à noite e termina ter de manhã na
   * mesma aba): o "hoje"/"amanhã" da validade e o limite do calendário ficaram velhos, e o banco, que confere a
   * validade com o dia de agora (D30), recusaria as condições inteiras. Com podeReabrir (volta à aba, ENVIAR) e tudo
   * o que ainda não chegou guardado no aparelho, reabre a cotação: datas e revs do banco, rascunhos do aparelho.
   * Senão (sem armazenamento, ou o relógio de 15 s com a aba à vista, que não reabre no meio da digitação), refaz as
   * datas aqui mesmo. Devolve a promessa da reabertura, ou null.
   */
  function conferirDia(esta, podeReabrir) {
    if (!esta || esta !== P || esta.vista !== 'form' || !esta.dia || esta.enviando || esta.aguardando) return null;
    const dia = diaLocalAgora(esta);
    if (!dia || dia <= esta.dia) return null;
    if (podeReabrir && tudoNoAparelho(esta)) return abrir(esta);
    refazerDatas(esta, dia);
    return null;
  }

  /** A reabertura remonta a tela a partir do aparelho: só reabre se tudo o que ainda não chegou está guardado lá. */
  function tudoNoAparelho(esta) {
    const s = esta.storage;
    if (!s || esta.previa) return false;
    const guardado = function (r, rev, form) { return !!r && r.rev === rev && JSON.stringify(r.v) === JSON.stringify(form); };
    for (let i = 0; i < esta.itens.length; i++) {
      const ei = esta.itens[i];
      if (ei.rascunho && !guardado(lerJson(s, chaveItem(esta.h, ei.item.numero)), ei.rascunho.rev, ei.form)) return false;
    }
    const g = esta.gerais;
    if (g && g.rascunho && !guardado(lerJson(s, chaveGerais(esta.h)), g.rascunho.rev, g.form)) return false;
    if (esta.envio) {
      const e = lerJson(s, chaveEnvio(esta.h));
      if (!e || e.envio_id !== esta.envio.envio_id) return false;
    }
    return true;
  }

  /** Sem reabrir: as datas da validade de hoje (mesma regra do banco), sem mexer no resto da tela. */
  function refazerDatas(esta, dia) {
    esta.dia = dia;
    const g = esta.gerais;
    if (!g) return;
    g.hoje = dia;
    g.opcoes = opcoesValidade(dia);
    if (!g.view) return;
    montarBotoesValidade(g);
    if (g.rascunho && validadePassou(g.form, dia)) g.mostrarErro = true;
    preencherGerais(g);
    sincronizarGerais(g);
  }

  /** Relógio do banco: fecha a página no fechamento, sem olhar a hora do celular. */
  function atualizarRelogio() {
    const esta = P;
    if (!esta || esta.vista !== 'form' || !esta.dados) return;
    // aba à vista na virada do dia: só as datas da validade (a reabertura fica para a volta à aba e o ENVIAR)
    if (!document.hidden) conferirDia(esta, false);
    const seg = segundosRestantes(esta);
    if (seg <= 0 && !esta.fechado) {
      esta.fechado = true;
      travarFormulario();
    }
    esta.viewPrazo.textContent = textoPrazo(esta.dados, seg);
    esta.viewPrazo.className = 'prazo' + (esta.fechado ? ' encerrada' : '');
    atualizarGeral();
  }

  /**
   * Trava os campos: no fechamento, tudo; na prévia, tudo menos "Mais opções" (o Ivan vê o que o vendedor vê,
   * sem conseguir editar).
   */
  function travarFormulario(previa) {
    const c = porId('conteudo');
    const campos = c.querySelectorAll('input, textarea, button');
    for (let i = 0; i < campos.length; i++) {
      if (previa && campos[i].getAttribute('data-livre') === '1') continue;
      campos[i].disabled = true;
    }
    c.classList.add(previa ? 'so-leitura' : 'fechada');
  }

  // ---------- ENVIAR

  /** Itens que não dá para mandar como estão (as condições têm o aviso próprio, no rodapé). */
  function textoFaltaCompletar(m) {
    return 'Falta completar ' + (m.invalidos.length === 1 ? 'o item ' : 'os itens ') + juntarComE(m.invalidos) + '.';
  }

  /** Depois de um ENVIAR, o que não pôde ir mostra o erro junto do campo. */
  function marcarErros(esta, m) {
    for (let i = 0; i < esta.itens.length; i++) {
      const ei = esta.itens[i];
      if (m.invalidos.indexOf(ei.item.numero) >= 0) {
        ei.mostrarErro = true;
        sincronizarItem(ei);
      }
    }
    if (m.geraisInvalidas) {
      esta.gerais.mostrarErro = true;
      sincronizarGerais(esta.gerais);
    }
  }

  /**
   * Leva a tela ao primeiro problema, na ordem da tela: o item que não pôde ir neste ENVIAR; senão, a condição que
   * falta (conferida na hora: o vendedor pode ter completado com o envio no ar).
   */
  function irAoProblema(esta, m) {
    if (m.invalidos.length) rolarAte(porId('item-' + m.invalidos[0]));
    else irParaCondicao(esta, false);
  }

  function conflitosAbertos(esta) {
    for (let i = 0; i < esta.itens.length; i++) if (esta.itens[i].conflito) return true;
    return !!(esta.gerais && esta.gerais.conflito);
  }

  /**
   * Manda só o que mudou. O envio_id nasce quando há alteração depois do último envio confirmado e é reusado
   * enquanto o envio não for confirmado (sem rede, devagar, aba fechada). Com a resposta, o rev de cada item
   * vira o devolvido; conflitos e erros ficam no item.
   */
  function enviar(opcoes) {
    const esta = P;
    const op = opcoes || {};
    if (!esta || esta.previa || esta.enviando || esta.vista !== 'form') return Promise.resolve();
    if (!op.auto) {
      esta.devagarSeguidos = 0;
      esta.aguardando = false;
    }
    // o dia virou com a página aberta: primeiro a tela de hoje (reaberta, ou com as datas refeitas); o toque vale
    const reaberta = conferirDia(esta, true);
    if (reaberta) return reaberta.then(function () { return P === esta && esta.vista === 'form' ? enviar(op) : undefined; });
    esta.mensagem = null;
    if (esta.fechado && !esta.envio) {
      esta.mensagem = 'A cotação já fechou; o que não foi enviado ficou só neste celular. ' + TEXTO_WHATSAPP;
      atualizarGeral();
      return Promise.resolve();
    }
    // condição incompleta ou inválida nunca segura os preços: os itens válidos vão, as condições só inteiras e certas
    // (achado do teste real de 28/09: boleto sem os dias travava tudo e o campo ficava fora da tela)
    const m = montarEnvio(esta.itens, esta.gerais);
    marcarErros(esta, m);
    if (!m.p_itens.length && !m.p_gerais) {
      if (m.invalidos.length) esta.mensagem = textoFaltaCompletar(m);
      else if (conflitosAbertos(esta)) esta.mensagem = 'Escolha, nos itens marcados, qual valor fica.';
      else if (!m.geraisInvalidas && esta.envio) {
        esta.envio = null;
        apagarChave(esta.storage, chaveEnvio(esta.h));
      }
      atualizarGeral();
      irAoProblema(esta, m);
      return Promise.resolve();
    }
    if (!esta.envio) esta.envio = { envio_id: novoUuid(), numeros: [], gerais: false };
    esta.envio.numeros = m.numeros;
    esta.envio.gerais = m.p_gerais !== null;
    // o corpo vai junto: depois do fechamento a abertura vem sem itens e só ele permite refazer este envio
    gravarJson(esta.storage, chaveEnvio(esta.h), {
      t: agoraMs(), envio_id: esta.envio.envio_id, numeros: m.numeros, gerais: esta.envio.gerais,
      p_itens: m.p_itens, p_gerais: m.p_gerais
    });
    esta.enviando = true;
    esta.falhaRede = false;
    atualizarGeral();
    const corpo = { p_codigo: esta.codigo, p_envio_id: esta.envio.envio_id, p_itens: m.p_itens, p_gerais: m.p_gerais };
    return chamar('cotacao_responder', corpo).then(function (r) {
      if (P !== esta) return undefined;
      esta.enviando = false;
      // o dia pode ter virado com o envio no ar (a recusa da validade vem daí): as datas de hoje já na tela
      conferirDia(esta, false);
      if (!r.ok) {
        esta.falhaRede = true;
        atualizarGeral();
        return undefined;
      }
      const j = r.json;
      if (j.ok === true) {
        esta.devagarSeguidos = 0;
        aplicarResultado(esta, j);
        esta.envio = null;
        apagarChave(esta.storage, chaveEnvio(esta.h));
        esta.recebidoEm = horaRecebido(j.recebido_em) || esta.recebidoEm;
        if (m.invalidos.length) esta.mensagem = textoFaltaCompletar(m);
        else if (conflitosAbertos(esta)) esta.mensagem = 'Alguns itens foram alterados depois que você abriu. Escolha qual valor fica.';
        atualizarGeral();
        // reenvio de um envio antigo que já tinha chegado: o que foi editado depois ainda não foi — manda agora
        if (j.reenvio === true && !op.seguimento && haEnviavel(esta)) return enviar({ seguimento: true });
        // chegou o que podia ir: a tela vai ao que ainda falta (o aviso do rodapé diz o quê e leva de novo)
        irAoProblema(esta, m);
        return undefined;
      }
      return tratarRecusa(esta, j, op);
    });
  }

  function tratarRecusa(esta, j, op) {
    if (j.erro === 'devagar') {
      if (esta.devagarSeguidos < MAX_DEVAGAR) {
        esta.devagarSeguidos++;
        esta.aguardando = true;
        esta.mensagem = j.texto || 'Aguarde alguns segundos.';
        atualizarGeral();
        const espera = Math.max(0, Number(j.espera_s) || 3) * 1000;
        return new Promise(function (resolver) {
          window.setTimeout(function () {
            if (P !== esta) { resolver(); return; }
            esta.aguardando = false;
            enviar({ auto: true, seguimento: op.seguimento }).then(resolver, resolver);
          }, espera);
        });
      }
      esta.devagarSeguidos = 0;
      esta.mensagem = j.texto || 'Aguarde alguns segundos.';
      atualizarGeral();
      return undefined;
    }
    if (j.erro === 'estado' || j.erro === 'codigo_invalido') {
      // a cotação mudou (fechou, foi substituída, cancelada, link trocado): o envio pendente não vale mais
      esta.envio = null;
      apagarChave(esta.storage, chaveEnvio(esta.h));
      mostrarEstado({ estado: j.erro === 'estado' ? j.estado : 'codigo_invalido', texto: j.texto || TEXTO_CODIGO_INVALIDO, nova: j.nova || null });
      return undefined;
    }
    if (j.erro === 'formato' || j.erro === 'envio_de_outra_cotacao') {
      // repetir o mesmo envio daria a mesma recusa: o próximo ENVIAR nasce com envio_id novo
      esta.envio = null;
      apagarChave(esta.storage, chaveEnvio(esta.h));
    }
    esta.mensagem = j.texto || TEXTO_WHATSAPP;
    atualizarGeral();
    return undefined;
  }

  function acharItem(esta, numero) {
    for (let i = 0; i < esta.itens.length; i++) if (esta.itens[i].item.numero === numero) return esta.itens[i];
    return null;
  }

  function aplicarResultado(esta, j) {
    const itens = Array.isArray(j.itens) ? j.itens : [];
    for (let i = 0; i < itens.length; i++) {
      const r = itens[i];
      const ei = acharItem(esta, r.numero);
      if (!ei) continue;
      const maisNovo = typeof r.rev === 'number' && r.rev >= ei.rev;
      const revAntes = ei.rev;
      if (r.resultado === 'gravado') {
        const va = r.valor_atual || null;
        if (maisNovo) {
          ei.rev = r.rev;
          if (va) ei.servidor = va;
        }
        if (ei.rascunho) {
          // resultado antigo (reenvio com rev menor que o da tela: o Ivan mudou o item depois): o que vale é o
          // valor que a tela conhece; o rascunho só sai se bater com ele — senão fica sobre o rev antigo e o
          // seguimento do reenvio recebe o conflito ("Manter o meu" / "Ficar com"), nunca "Recebido" com outro valor
          const atual = maisNovo ? va : ei.servidor;
          const e = entradaDoForm(ei.item, ei.form).entrada;
          if (e && atual && mesmaResposta(e, atual)) {
            descartarRascunho(ei);   // chegou: o rascunho deste item sai do aparelho
          } else if (maisNovo) {
            ei.rascunho.rev = r.rev;  // editado depois do envio: continua pendente, agora sobre o valor gravado
            salvarItem(ei);
          }
        } else {
          // sem rascunho: o vendedor pode ter voltado o campo ao valor antigo enquanto o envio estava no ar;
          // se a tela não bate com o que foi gravado, a volta vira rascunho pendente (vai no próximo ENVIAR)
          salvarItem(ei);
        }
        ei.conflito = false;
        ei.erroServidor = null;
      } else if (r.resultado === 'conflito') {
        if (maisNovo) {
          ei.rev = r.rev;
          if (r.valor_atual) ei.servidor = r.valor_atual;
        }
        if (ei.rascunho) {
          const e = entradaDoForm(ei.item, ei.form).entrada;
          if (e && mesmaResposta(e, ei.servidor)) descartarRascunho(ei);
          else ei.conflito = true;
        } else {
          // sem rascunho (voltou ao valor antigo durante o envio) e o banco tem outro valor: a tela não pode
          // fingir que está gravada; vira rascunho sobre o rev que o vendedor viu, à espera da escolha
          const e = entradaDoForm(ei.item, ei.form).entrada;
          if (!(e && mesmaResposta(e, ei.servidor))) {
            ei.rascunho = { rev: revAntes };
            ei.conflito = true;
            salvarItem(ei);
          }
        }
        ei.erroServidor = null;
      } else if (r.resultado === 'erro') {
        if (r.erro === 'numero_inexistente') {
          descartarRascunho(ei);
        } else if (maisNovo && r.valor_atual) {
          ei.rev = r.rev;
          ei.servidor = r.valor_atual;
        }
        ei.erroServidor = r.erro || 'valor_invalido';
      }
      sincronizarItem(ei);
    }
    const rg = j.gerais;
    const g = esta.gerais;
    if (rg && g) {
      const maisNovo = typeof rg.rev === 'number' && rg.rev >= g.rev;
      const revAntes = g.rev;
      if (rg.resultado === 'gravado') {
        if (maisNovo) {
          g.rev = rg.rev;
          if (rg.valor_atual) g.servidor = rg.valor_atual;
        }
        if (g.rascunho) {
          // resultado antigo (rg.rev < g.rev): compara com as condições que a tela conhece (mesma regra dos itens)
          const x = geraisDoForm(g.form, g.hoje);
          const bate = maisNovo ? !!rg.valor_atual && mesmosGerais(x.gerais, rg.valor_atual) : mesmosGerais(x.gerais, g.servidor);
          if (x.gerais && bate) {
            descartarRascunhoGerais(g);
          } else if (maisNovo) {
            g.rascunho.rev = rg.rev;
            salvarGerais(g);
          }
        } else {
          salvarGerais(g);   // sem rascunho: a tela precisa bater com o gravado (mesma regra dos itens)
        }
        g.conflito = false;
        g.erroServidor = null;
      } else if (rg.resultado === 'conflito') {
        if (maisNovo) {
          g.rev = rg.rev;
          if (rg.valor_atual) g.servidor = rg.valor_atual;
        }
        if (g.rascunho) {
          const x = geraisDoForm(g.form, g.hoje);
          if (x.gerais && mesmosGerais(x.gerais, g.servidor)) descartarRascunhoGerais(g);
          else g.conflito = true;
        } else {
          const x = geraisDoForm(g.form, g.hoje);
          if (!(x.gerais && mesmosGerais(x.gerais, g.servidor))) {
            g.rascunho = { rev: revAntes };
            g.conflito = true;
            salvarGerais(g);
          }
        }
        g.erroServidor = null;
      } else if (rg.resultado === 'erro') {
        g.erroServidor = rg.erro || 'valor_invalido';
      }
      sincronizarGerais(g);
    }
  }

  // ---------- ligação com a página

  window.CotacaoPagina = {
    // puras (testadas em tests/)
    lerNumero: lerNumero,
    lerDinheiro: lerDinheiro,
    formatarReais: formatarReais,
    formatarQtd: formatarQtd,
    sha256hex: sha256hex,
    novoUuid: novoUuid,
    lerHash: lerHash,
    chaveItem: chaveItem,
    chaveGerais: chaveGerais,
    chaveEnvio: chaveEnvio,
    limparRascunhosVelhos: limparRascunhosVelhos,
    converter: converter,
    contaAoVivo: contaAoVivo,
    textoQuantidade: textoQuantidade,
    textoUltimaNota: textoUltimaNota,
    textoRecebimento: textoRecebimento,
    textoAviso: textoAviso,
    textoPrazo: textoPrazo,
    horaRecebido: horaRecebido,
    lerDataDigitada: lerDataDigitada,
    opcoesValidade: opcoesValidade,
    formVazio: formVazio,
    formDaResposta: formDaResposta,
    entradaDoForm: entradaDoForm,
    mesmaResposta: mesmaResposta,
    formDosGerais: formDosGerais,
    geraisDoForm: geraisDoForm,
    mesmosGerais: mesmosGerais,
    montarEnvio: montarEnvio,
    // tela
    iniciar: iniciar,
    enviar: enviar,
    atualizarRelogio: atualizarRelogio
  };

  function ligar() {
    porId('enviar').addEventListener('click', function () { enviar(); });
    porId('faixa-pendente').addEventListener('click', function () { enviar(); });
    porId('completar').addEventListener('click', function () {
      if (P && P.vista === 'form' && !somenteLeitura()) irParaCondicao(P, true);
    });
    window.addEventListener('hashchange', function () { iniciar(); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      // de volta à aba (o celular dormiu): se o dia virou, reabre com as datas de hoje; senão, só o relógio
      if (!conferirDia(P, true)) atualizarRelogio();
    });
    iniciar();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ligar);
  else ligar();
})(window);
