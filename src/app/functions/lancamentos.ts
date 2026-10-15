import { Lancamento, LinhaOrigem, Rateio } from '../interfaces/stc.interface';

// Estrutura de trabalho da tela de Origem — mesmo Lancamento/Rateio do port
// `getLancamentos`, só com `selecionado` adicionado em cada rateio pra
// controlar o checkbox (campo transitório, nunca vai pro payload do BPM).
export interface RateioLinha extends Rateio {
  selecionado: boolean;
}
export interface LancamentoLinha extends Omit<Lancamento, 'rateios'> {
  rateios: RateioLinha[];
}

// Normaliza um campo que DEVERIA ser array, mas conectores SOAP/XML-to-JSON
// (como o desse connector-invoke) costumam colapsar array de 1 item num
// objeto solto, ou mandar como string JSON — mesma classe de inconsistência
// já vista em outros ports (ver extrair-lista.ts). Sem isso, um lançamento
// com um rateio só (`rateios` vindo como objeto, não array) quebrava
// `.map is not a function`.
function paraArray<T>(valor: T[] | T | string | null | undefined): T[] {
  if (Array.isArray(valor)) {
    return valor;
  }
  if (typeof valor === 'string') {
    try {
      return paraArray(JSON.parse(valor));
    } catch {
      return [];
    }
  }
  return valor ? [valor] : [];
}

export function paraLancamentoLinha(lancamentos: Lancamento[] | any): LancamentoLinha[] {
  const lista: Lancamento[] = paraArray(lancamentos);
  return lista.map((lct) => ({
    ...lct,
    rateios: paraArray(lct.rateios).map((rateio) => ({ ...rateio, selecionado: false })),
  }));
}

// debCre indica se o rateio é lado Débito ou Crédito — confirmado contra
// payload real em 2026-08-26: "D"/"C". Mantidas as outras variações como
// tolerância extra, sem custo.
export function normalizarNaturezaRateio(
  debCre?: string
): 'Debito' | 'Credito' | undefined {
  const valor = (debCre || '').trim().toUpperCase();
  if (['D', 'DB', 'DEB', 'DEBITO', 'DÉBITO', '1'].includes(valor)) {
    return 'Debito';
  }
  if (['C', 'CR', 'CRE', 'CREDITO', 'CRÉDITO', '2'].includes(valor)) {
    return 'Credito';
  }
  return undefined;
}

// Achata os rateios SELECIONADOS de cada lançamento numa lista de LinhaOrigem
// (uma por rateio DE CRÉDITO) — chamado em OrigemComponent.avancarEtapa().
// `lancamento` (chave única por linha, usada por montarComparativo/
// LinhaDestino) é sintetizado como `${numLct}-${índice do rateio}`; `numLct`
// (chave de AGRUPAMENTO — vários rateios do mesmo lançamento compartilham) é
// o número do lançamento em si.
//
// Só rateios de CRÉDITO virão como linha de Origem — confirmado pelo usuário
// em 2026-10-14: o rateio de Débito de um lançamento é sempre o lado que
// "desconta"/estorna a origem (automático, via o próprio estorno gerado pra
// cada Crédito em `montarParDeRateios`, functions/integracao-erp.ts), nunca
// precisa de um destino escolhido nem aparece como linha própria de
// aprovação. Antes disso, CADA rateio (Débito ou Crédito) virava sua própria
// linha de Origem pedindo destino — é isso que gerava, por exemplo, um
// lançamento com 1 Débito + 1 Crédito aparecendo como "2 destinos" na tela,
// e further down na integração.
export function achatarRateiosSelecionados(lancamentos: LancamentoLinha[]): LinhaOrigem[] {
  const linhas: LinhaOrigem[] = [];
  lancamentos.forEach((lct) => {
    lct.rateios.forEach((rateio, indice) => {
      if (!rateio.selecionado) {
        return;
      }
      if (normalizarNaturezaRateio(rateio.debCre) !== 'Credito') {
        return;
      }
      linhas.push({
        lancamento: `${lct.numLct}-${indice}`,
        numLot: lct.numLot,
        numLct: lct.numLct,
        oriLct: lct.oriLct,
        datLct: lct.datLct ?? rateio.datLct,
        ctaRed: rateio.ctaRed,
        codCcu: rateio.codCcu,
        numPrj: rateio.numPrj,
        codFpj: rateio.codFpj,
        ctaFin: rateio.ctaFin,
        natureza: normalizarNaturezaRateio(rateio.debCre),
        valor: Number(rateio.vlrRat) || 0,
        historico: lct.cplLct,
      });
    });
  });
  return linhas;
}
