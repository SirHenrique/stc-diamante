import { LinhaDestino, LinhaOrigem } from '../interfaces/stc.interface';

// Combina cada linha de origem com a linha de destino correspondente (mesmo
// `lancamento`) — usado no grid "Comparativo Origem x Destino" das telas de
// aprovação e no resumo final do solicitante.
export interface LinhaComparativo {
  lancamento?: string;
  origem: LinhaOrigem;
  destino?: LinhaDestino;
}

// Casa cada Origem com TODOS os destinos de mesmo `lancamento` — não só o
// primeiro. Alterado em 2026-10-14 pra suportar o split de 1 crédito em N
// destinos no Por Lote (`DestinoComponent`, modo Múltiplo): em vez de
// duplicar/mutar a linha de Origem (como o Manual faz, com chaves
// sintéticas por fatia), o Destino pode gerar N `LinhaDestino` com o MESMO
// `lancamento` da origem — cada um vira sua própria linha de comparativo,
// com a MESMA origem (mesma conta/CC/natureza) e o valor da fatia (via
// `destino.valor` em `montarParDeRateios`, functions/integracao-erp.ts).
// Quando há só 1 destino por origem (todo o resto do app: Manual, Por Lote
// Único, Por Lote Múltiplo sem split) o comportamento é idêntico ao de
// antes — só quando há split (N>1) é que aparece mais de 1 linha pra mesma
// origem, com `lancamento` desambiguado (sufixo "/1", "/2"...) só pra manter
// único no `dataKey` das tabelas (Aprovação/Resumo/Impressão).
export function montarComparativo(
  dados: LinhaOrigem[] | any,
  linhasDestino: LinhaDestino[] | any
): LinhaComparativo[] {
  const origens: LinhaOrigem[] = Array.isArray(dados) ? dados : [];
  const destinos: LinhaDestino[] = Array.isArray(linhasDestino) ? linhasDestino : [];
  const linhas: LinhaComparativo[] = [];

  origens.forEach((origem) => {
    const correspondentes = destinos.filter((d) => d.lancamento === origem.lancamento);
    if (!correspondentes.length) {
      linhas.push({ lancamento: origem.lancamento, origem, destino: undefined });
      return;
    }
    correspondentes.forEach((destino, i) => {
      linhas.push({
        lancamento: correspondentes.length > 1 ? `${origem.lancamento}/${i + 1}` : origem.lancamento,
        origem,
        destino,
      });
    });
  });

  return linhas;
}

// REESCRITA em 2026-08-31 — cada linha soma IGUAL pro Débito Total e pro
// Crédito Total, sempre. Motivo: desde que o modelo real de postagem no ERP
// foi mapeado (`postLancamentos`, ver functions/integracao-erp.ts), cada
// linha selecionada gera 2 rateios que JÁ vão pro ERP — um Rateio Destino
// (mesma natureza da origem) e um Rateio Origem/estorno (natureza
// invertida, "pra descontarmos") — ou seja, toda linha, sozinha, sempre gera
// um lançamento perfeitamente balanceado (1 débito + 1 crédito do mesmo
// valor). O Saldo (Débito Total − Crédito Total) é sempre 0 por construção
// agora — não é mais uma validação de seleção desbalanceada (essa
// validação não faz mais sentido: cada linha se balanceia sozinha via o
// estorno de origem, não depende de outras linhas selecionadas em conjunto
// pra "fechar").
//
// Nota histórica: essa função já teve pelo menos 4 versões (destino-só →
// origem+destino com `if`/`if` → origem+destino com `else if`/`else if` →
// origem-só → esta, origem+destino de novo). A versão "origem-só" (a
// anterior a esta) fazia sentido no modelo antigo, onde 1 rateio de origem
// virava só 1 rateio de destino (sem estorno) — o Saldo genuinamente podia
// acusar seleção incompleta. Com o estorno, isso não existe mais: se essa
// regra for revisitada de novo, o ponto central é que o balanceamento
// agora é POR LINHA (garantido pelo par Destino+Estorno), não pela seleção
// inteira.
export function totalPorNatureza(
  linhas: LinhaComparativo[],
  _natureza: 'Debito' | 'Credito'
): number {
  return linhas.reduce((total, l) => total + (l.destino?.valor ?? l.origem?.valor ?? 0), 0);
}
