import { LinhaComparativo } from './comparativo';
import { LancamentoIntegracao, RateioIntegracao } from '../interfaces/stc.interface';
import { inverterNatureza } from './regra-destino';

function paraDebCre(natureza: 'Debito' | 'Credito' | undefined): 'D' | 'C' {
  return natureza === 'Debito' ? 'D' : 'C';
}

// Par de rateios (Destino + Origem/estorno) de UMA linha do comparativo —
// mesmo cálculo pro Por Lote (1 par = 1 lançamento) e pro Manual (N pares
// consolidados em 1 lançamento só, ver construirLancamentoManual abaixo).
//
// Modelo confirmado pelo usuário em 2026-08-31 (2 rodadas — a 1ª explicação
// tinha uma inversão errada, corrigida na 2ª):
//   1. Rateio "Destino": classificação (Conta/CC/Projeto/Fase) escolhida
//      pelo solicitante — natureza IGUAL à do rateio real de origem (NÃO
//      inverte: "o rateio será o crédito e no destino ele continuará sendo
//      crédito").
//   2. Rateio "Origem" (estorno): classificação ORIGINAL do rateio real
//      (a mesma Conta/CC/Projeto/Fase que já veio de getLancamentos, ou —
//      no Manual — a mesma digitada em Origem) — natureza INVERTIDA ("só
//      vira débito o de origem, pra descontarmos") — é o que zera/desconta
//      o valor de onde ele estava antes.
function montarParDeRateios(l: LinhaComparativo): {
  rateioDestino: RateioIntegracao;
  rateioOrigemEstorno: RateioIntegracao;
  debCreDestino: 'D' | 'C';
  debCreOrigem: 'D' | 'C';
  valor: number;
} {
  const origem = l.origem;
  const destino = l.destino!;
  const valor = destino.valor ?? origem.valor ?? 0;
  const debCreDestino = paraDebCre(origem.natureza);
  const debCreOrigem = paraDebCre(inverterNatureza(origem.natureza));

  const rateioDestino: RateioIntegracao = {
    ctaRed: destino.ctaRed ?? '',
    codCcu: destino.codCcu ?? '',
    ctaFin: origem.ctaFin ?? '',
    perRat: 100,
    debCre: debCreDestino,
    numPrj: destino.numPrj ?? '',
    codFpj: destino.codFpj ?? '',
    vlrRat: valor,
  };

  const rateioOrigemEstorno: RateioIntegracao = {
    ctaRed: origem.ctaRed ?? '',
    codCcu: origem.codCcu ?? '',
    ctaFin: origem.ctaFin ?? '',
    perRat: 100,
    debCre: debCreOrigem,
    numPrj: origem.numPrj ?? '',
    codFpj: origem.codFpj ?? '',
    vlrRat: valor,
  };

  return { rateioDestino, rateioOrigemEstorno, debCreDestino, debCreOrigem, valor };
}

// Por Lote (tipo "L"): 1 lançamento NOVO por LANÇAMENTO REAL original
// (agrupado por `origem.numLct`), não mais por linha — CORRIGIDO em
// 2026-10-14. Cada linha do comparativo já é só um rateio de CRÉDITO
// selecionado (`achatarRateiosSelecionados()`, functions/lancamentos.ts —
// o Débito nunca chega aqui como linha própria, ele é só o estorno
// automático de cada Crédito, via `montarParDeRateios`). Antes desta
// correção, cada rateio (inclusive o de Débito, quando também virava linha)
// gerava seu PRÓPRIO lançamento novo separado — pra um lançamento real com,
// por exemplo, 1 Débito + 1 Crédito, isso mandava 2 lançamentos novos pro
// Sapiens, cada um incompleto (só 2 dos 4 rateios) — causa real do bug
// reportado pelo cliente (STC 702, lançamento 225024: `dados` saía vazio,
// porque os 2 rateios tinham Centro de Custo "99999999", removido pelo
// filtro abaixo que existia antes — ver nota em
// construirLancamentosIntegracao). Agora: todos os Créditos do MESMO
// lançamento original (mesmo `numLct`) entram juntos num lançamento novo só,
// com todos os pares Destino+Origem-estorno dentro de `rateios[]` — mesmo
// padrão já usado em construirLancamentoManual() (abaixo).
//
// Cabeçalho `ctaDeb`/`ctaCre` (E640LCT) — mesma ressalva já aceita no
// Manual: com N créditos de contas diferentes no mesmo lançamento, usa a
// conta do PRIMEIRO crédito do grupo como valor do cabeçalho; os rateios
// reais dentro de `rateios[]` continuam corretos cada um com sua própria
// conta, independente disso.
function construirLancamentosPorLote(
  linhas: LinhaComparativo[],
  codEmp: string | undefined,
  codFil: string | undefined
): LancamentoIntegracao[] {
  const grupos = new Map<string, LinhaComparativo[]>();
  linhas.forEach((l) => {
    const chave = l.origem.numLct ?? l.origem.lancamento ?? '';
    const grupo = grupos.get(chave);
    if (grupo) {
      grupo.push(l);
    } else {
      grupos.set(chave, [l]);
    }
  });

  return Array.from(grupos.values()).map((grupo) => {
    const origem = grupo[0].origem;
    const rateios: RateioIntegracao[] = [];
    let vlrLct = 0;
    grupo.forEach((l) => {
      const { rateioDestino, rateioOrigemEstorno, valor } = montarParDeRateios(l);
      rateios.push(rateioDestino, rateioOrigemEstorno);
      vlrLct += valor;
    });

    const primeiro = montarParDeRateios(grupo[0]);
    const destinoPrimeiro = grupo[0].destino!;
    const ctaDeb =
      (primeiro.debCreDestino === 'D' ? destinoPrimeiro.ctaRed : origem.ctaRed) ?? '';
    const ctaCre =
      (primeiro.debCreDestino === 'C' ? destinoPrimeiro.ctaRed : origem.ctaRed) ?? '';

    return {
      codEmp: codEmp ?? '',
      numLot: origem.numLot,
      numLct: origem.numLct ?? origem.lancamento ?? '',
      oriLct: origem.oriLct,
      codFil: codFil ?? '',
      datLct: origem.datLct ?? '',
      ctaDeb,
      ctaCre,
      vlrLct,
      cplLct: destinoPrimeiro.historico ?? origem.historico ?? '',
      rateios,
    };
  });
}

// Manual (tipo "M"): diferente do Por Lote, NÃO existe um lançamento real do
// ERP sendo reclassificado — é 1 movimento novo só, criado do zero pelo
// solicitante (que pode ter N destinos, ver OrigemDestinoManualComponent —
// split 1 origem -> N destinos, pedido do usuário em 2026-09-02). Confirmado
// pelo usuário no mesmo dia ("mesma estrutura só que daí é um lançamento com
// vários rateios"): todas as N fatias viram RATEIOS de 1 ÚNICO lançamento
// (2N rateios: N pares Destino+Origem-estorno), não N lançamentos separados
// como o Por Lote.
//
// ATENÇÃO — `ctaDeb`/`ctaCre` do CABEÇALHO NÃO CONFIRMADO com N destinos de
// contas diferentes: o header só tem 1 valor de cada, mas o lado Origem
// (estorno) é sempre a MESMA conta em toda fatia (só existe 1 origem no
// Manual) — usada com segurança abaixo — enquanto o lado Destino pode ter
// até N contas diferentes (1 por destino). Usa a conta do PRIMEIRO destino
// como valor mais plausível pro campo do cabeçalho — os N rateios de
// verdade (cada um com sua própria conta) continuam corretos dentro de
// `rateios[]` independente disso. CONFIRMAR com o usuário/ERP antes de
// considerar definitivo, principalmente se os destinos tiverem contas
// diferentes entre si.
function construirLancamentoManual(
  linhas: LinhaComparativo[],
  codEmp: string | undefined,
  codFil: string | undefined
): LancamentoIntegracao[] {
  if (!linhas.length) {
    return [];
  }
  const origem = linhas[0].origem;
  const rateios: RateioIntegracao[] = [];
  let vlrLct = 0;

  linhas.forEach((l) => {
    const { rateioDestino, rateioOrigemEstorno, valor } = montarParDeRateios(l);
    rateios.push(rateioDestino, rateioOrigemEstorno);
    vlrLct += valor;
  });

  // Cabeçalho baseado no 1º destino (ver ressalva no comentário da função).
  const primeiroDestino = montarParDeRateios(linhas[0]);
  const ctaDeb =
    (primeiroDestino.debCreDestino === 'D'
      ? primeiroDestino.rateioDestino.ctaRed
      : origem.ctaRed) ?? '';
  const ctaCre =
    (primeiroDestino.debCreDestino === 'C'
      ? primeiroDestino.rateioDestino.ctaRed
      : origem.ctaRed) ?? '';

  return [
    {
      codEmp: codEmp ?? '',
      // Sem numLot/oriLct — STC Manual não tem lote/lançamento de origem
      // real no ERP (pedido do usuário em 2026-08-31).
      numLct: 'MANUAL-1',
      codFil: codFil ?? '',
      datLct: origem.datLct ?? '',
      ctaDeb,
      ctaCre,
      vlrLct,
      cplLct: origem.historico ?? '',
      rateios,
    },
  ];
}

// Monta o array `dados` do port `postLancamentos` (ver ENDPOINTS.txt) a
// partir do comparativo Origem×Destino da STC — Por Lote agrupa por
// lançamento original (um lançamento novo por numLct), Manual consolida
// tudo em 1 lançamento só (ver funções acima).
export function construirLancamentosIntegracao(
  linhas: LinhaComparativo[],
  tipo: 'M' | 'L',
  codEmp: string | undefined,
  codFil: string | undefined
): LancamentoIntegracao[] {
  // REMOVIDO em 2026-10-14 o filtro `l.origem.codCcu !== '99999999'`
  // ("rateio com CC 99999999 não conta pra integração", pedido do usuário em
  // 2026-08-31): causava o bug real reportado pelo cliente — um lançamento
  // cujos rateios usam só CC "99999999" (ex.: reclassificação bancária/
  // tesouraria, sem Centro de Custo aplicável) tinha TODAS as linhas
  // removidas por esse filtro, chegando vazio (`dados: []`) no
  // postLancamentos, mesmo depois de passar por todas as aprovações.
  // Confirmado pelo usuário: Centro de Custo 99999999 é um valor de destino
  // legítimo, não deveria nunca bloquear a integração — a garantia real é
  // outra (o Débito sempre descontar a origem), já assegurada antes disso,
  // em achatarRateiosSelecionados() (functions/lancamentos.ts), que só deixa
  // rateios de CRÉDITO virarem linha de Origem.
  const linhasValidas = linhas.filter((l) => !!l.destino);

  return tipo === 'M'
    ? construirLancamentoManual(linhasValidas, codEmp, codFil)
    : construirLancamentosPorLote(linhasValidas, codEmp, codFil);
}
