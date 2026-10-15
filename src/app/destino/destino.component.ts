import { Component, EventEmitter, Input, OnChanges, OnInit, Output, SimpleChanges } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { Mensagem } from '../interfaces/gerais.interface';
import {
  CentroCusto,
  ContaContabil,
  FaseProjeto,
  Formulario,
  LinhaDestino,
  LinhaOrigem,
  Lote,
  Projeto,
} from '../interfaces/stc.interface';
import { ServiceBpmService } from '../services/service-bpm.service';
import { extrairLista } from '../functions/extrair-lista';
import { montarHistoricoDestino } from '../functions/regra-destino';
import { gestoresDistintos } from '../functions/loop-gestor';

// 1 grupo por linha de Origem (rateio de Crédito real) — ver
// DestinoComponent.gruposDestino.
interface GrupoDestino {
  origem: LinhaOrigem;
  destinos: LinhaDestino[];
}

@Component({
  selector: 'app-destino',
  templateUrl: './destino.component.html',
  styleUrls: ['./destino.component.scss'],
})
export class DestinoComponent implements OnInit, OnChanges {
  // Componente fica vivo entre passos do wizard ([hidden], não *ngIf — ver
  // SolicitacaoComponent) — sem isso, voltar pra Origem e trocar quais
  // rateios estão selecionados não reconstruía `linhasDestino` (a de
  // ngOnInit já tinha rodado uma vez, pro conjunto antigo de rateios).
  // `assinaturaOrigem` (bind do parent, resumo dos `lancamento` selecionados)
  // muda de valor quando a seleção de Origem muda; `ngOnChanges` detecta e
  // reconstrói (ignora a primeira mudança, que coincide com a criação do
  // componente — ngOnInit já cuida dessa).
  @Input() assinaturaOrigem: string | undefined;

  @Output() enviaMensagem = new EventEmitter<Mensagem>();
  @Output() voltar = new EventEmitter<void>();
  @Output() proximaEtapa = new EventEmitter<void>();

  carregando: boolean = false;
  modo: 'Unico' | 'Multiplo' = 'Unico';

  contas: ContaContabil[] = [];

  // Filtro em cascata do segmento contábil (pedido do usuário em 2026-08-29,
  // ver ENDPOINTS.txt getProjetosPorContas/getCCPorContas/getFasesPorContas):
  // Conta -> Projeto -> (Centro de Custo + Fase, carregados juntos). Cache
  // compartilhado entre o modo Único (formUnico) e o modo Múltiplo (uma linha
  // por rateio) — se duas linhas usam a mesma Conta/Projeto, reaproveita a
  // mesma resposta em vez de buscar de novo.
  private projetosPorConta: Record<string, Projeto[]> = {};
  private carregandoProjetosDe = new Set<string>();
  private segmentosPorProjeto: Record<string, { cc: CentroCusto[]; fases: FaseProjeto[] }> = {};
  private carregandoSegmentoDe = new Set<string>();

  formUnico: FormGroup;
  // Único: continua 1:1 com a origem, 1 segmento replicado pra todas as
  // linhas (sem split) — ver avancarEtapa().
  linhasDestino: LinhaDestino[] = [];

  // Múltiplo: 1 grupo por linha de Origem (cada grupo = 1 rateio de Crédito
  // real selecionado), e cada grupo pode ter N destinos (pedido do usuário
  // em 2026-10-14: "quando escolho múltiplos destinos... não sabemos
  // quantos destinos pode ter" — mesma necessidade que já existia no Manual,
  // 2026-09-02, só que aqui aplicada por CRÉDITO real, não por origem
  // digitada). A soma dos destinos de um grupo precisa bater exatamente com
  // o valor do crédito original (ver grupoBalanceado()). Quando um grupo
  // fica com só 1 destino (não dividido), o resultado é idêntico ao 1:1 de
  // antes — `montarComparativo()` (functions/comparativo.ts) já sabe casar N
  // destinos com a mesma origem.
  gruposDestino: GrupoDestino[] = [];

  constructor(private fb: FormBuilder, private servico: ServiceBpmService) {
    this.formUnico = this.fb.group({
      ctaRed: [null, Validators.required],
      numPrj: [null, Validators.required],
      codCcu: [null, Validators.required],
      codFpj: [null, Validators.required],
    });
  }

  get dadosFormulario(): Formulario {
    return this.servico.dadosFormulario;
  }

  get linhasOrigem(): LinhaOrigem[] {
    return Array.isArray(this.dadosFormulario.dados) ? this.dadosFormulario.dados : [];
  }

  // Card "Resumo da Origem Selecionada" do mockup ("Destino unido.png") — ver
  // ServiceBpmService.loteSelecionado (transitório, só desta sessão; fica
  // vazio na modalidade Manual, que não passa pela Consulta do Lote).
  get loteSelecionado(): Lote | null {
    return this.servico.loteSelecionado;
  }

  get valorTotalOrigem(): number {
    return this.linhasOrigem.reduce((total, linha) => total + (linha.valor ?? 0), 0);
  }

  get segmentoUnicoValido(): boolean {
    return this.formUnico.valid;
  }

  get gestorSelecionado(): string | undefined {
    const ctaRed = this.formUnico.get('ctaRed')?.value;
    const numPrj = this.formUnico.get('numPrj')?.value;
    const codCcu = this.formUnico.get('codCcu')?.value;
    return this.centrosCustoDoSegmento(ctaRed, numPrj).find((c) => c.codCcu === codCcu)?.usuRes;
  }

  // Mostra o gestor ao vivo por linha no modo Múltiplo (mockup "Destino
  // multiplo.png" já traz a coluna "Aprovador" preenchida) — antes só
  // calculávamos isso no clique de Avançar, agora também na tela.
  gestorDaLinha(linha: LinhaDestino): string | undefined {
    return this.centrosCustoDoSegmento(linha.ctaRed, linha.numPrj).find(
      (c) => c.codCcu === linha.codCcu
    )?.usuRes;
  }

  ngOnInit(): void {
    this.carregarListas();
    this.inicializarLinhasDestino();
    this.inicializarGruposDestino();
    this.restaurarModoEFormUnico();

    // Filtro em cascata do segmento (Conta -> Projeto -> CC+Fase, ver
    // ENDPOINTS.txt) — trocar a Conta zera Projeto/CC/Fase e busca os
    // projetos daquela conta; trocar o Projeto zera CC/Fase e busca os dois
    // juntos (getCCPorContas + getFasesPorContas). `[disabled]` de cada campo
    // no HTML é calculado a partir do cache (projetosCarregados/
    // segmentoCarregado), não por .disable() do form — não precisa esperar a
    // resposta aqui pra habilitar nada.
    this.formUnico.get('ctaRed')?.valueChanges.subscribe((ctaRed) => {
      this.formUnico.get('numPrj')?.reset(null, { emitEvent: false });
      this.formUnico.get('codCcu')?.reset(null, { emitEvent: false });
      this.formUnico.get('codFpj')?.reset(null, { emitEvent: false });
      if (ctaRed) {
        this.garantirProjetosCarregados(ctaRed);
      }
    });

    this.formUnico.get('numPrj')?.valueChanges.subscribe((numPrj) => {
      this.formUnico.get('codCcu')?.reset(null, { emitEvent: false });
      this.formUnico.get('codFpj')?.reset(null, { emitEvent: false });
      const ctaRed = this.formUnico.get('ctaRed')?.value;
      if (numPrj && ctaRed) {
        this.garantirSegmentoCarregado(ctaRed, numPrj);
      }
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['assinaturaOrigem'] && !changes['assinaturaOrigem'].firstChange) {
      this.inicializarLinhasDestino();
      this.inicializarGruposDestino();
    }
  }

  // Natureza/valor/histórico são sempre recalculados a partir da origem
  // (determinístico, não muda entre sessões). Natureza do destino = MESMA
  // da origem (NÃO inverte) — corrigido em 2026-08-31, depois de mapear o
  // modelo real de postagem no ERP (`postLancamentos`, ver
  // functions/integracao-erp.ts): o Rateio Destino mantém a mesma natureza
  // do rateio real de origem ("no destino ele continuará sendo crédito"),
  // quem inverte é só o rateio de estorno da ORIGEM — não existe mais
  // inversão na natureza do Destino exibida na tela. Antes disso essa regra
  // já tinha flip-flopado várias vezes (inverte → mesma natureza → inverte
  // de novo, tudo em 2026-08-26) — essa é a versão definitiva, alinhada com
  // o que de fato é postado no ERP. `inverterNatureza()` continua existindo
  // (usado agora só dentro de `construirLancamentosIntegracao()` pro rateio
  // de estorno de origem), só não é mais usada pra calcular a natureza do
  // Destino. Já o segmento contábil de destino (ctaRed/codCcu/numPrj/codFpj
  // e descrições) só existe se o solicitante já tinha preenchido antes de
  // uma devolução (STC reaberta) — casa por `lancamento` com
  // `dadosFormulario.linhasDestino` salvo. Sem isso, reabrir uma STC
  // devolvida sempre voltava com o segmento em branco.
  private inicializarLinhasDestino(): void {
    const salvas = Array.isArray(this.dadosFormulario.linhasDestino)
      ? this.dadosFormulario.linhasDestino
      : [];
    const salvasPorLancamento = new Map(salvas.map((l: LinhaDestino) => [l.lancamento, l]));

    this.linhasDestino = this.linhasOrigem.map((origem) => {
      const salva = salvasPorLancamento.get(origem.lancamento);
      return {
        lancamento: origem.lancamento,
        numLct: origem.numLct,
        natureza: origem.natureza,
        valor: origem.valor,
        historico: montarHistoricoDestino(this.dadosFormulario.numeroStc, origem.historico),
        ctaRed: salva?.ctaRed,
        desCta: salva?.desCta,
        codCcu: salva?.codCcu,
        desCcu: salva?.desCcu,
        numPrj: salva?.numPrj,
        nomPrj: salva?.nomPrj,
        codFpj: salva?.codFpj,
        desFpj: salva?.desFpj,
        gestor: salva?.gestor,
      };
    });

    salvas.forEach((salva: LinhaDestino) => {
      if (salva.ctaRed) {
        this.garantirProjetosCarregados(salva.ctaRed);
        if (salva.numPrj) {
          this.garantirSegmentoCarregado(salva.ctaRed, salva.numPrj);
        }
      }
    });
  }

  // Monta os grupos do modo Múltiplo — 1 por linha de Origem (rateio de
  // Crédito), com N destinos cada (ver GrupoDestino acima). `linhasDestino`
  // salvo pode ter mais de 1 entrada com o MESMO `lancamento` quando um
  // grupo já foi dividido numa sessão anterior (STC devolvida) — agrupa por
  // essa chave antes de distribuir.
  private inicializarGruposDestino(): void {
    const salvas = Array.isArray(this.dadosFormulario.linhasDestino)
      ? this.dadosFormulario.linhasDestino
      : [];
    const salvasPorLancamento = new Map<string, LinhaDestino[]>();
    salvas.forEach((l: LinhaDestino) => {
      const grupo = salvasPorLancamento.get(l.lancamento ?? '');
      if (grupo) {
        grupo.push(l);
      } else {
        salvasPorLancamento.set(l.lancamento ?? '', [l]);
      }
    });

    this.gruposDestino = this.linhasOrigem.map((origem) => {
      const historico = montarHistoricoDestino(this.dadosFormulario.numeroStc, origem.historico);
      const salvasDoGrupo = salvasPorLancamento.get(origem.lancamento ?? '') ?? [];
      const destinos: LinhaDestino[] = (salvasDoGrupo.length ? salvasDoGrupo : [undefined]).map(
        (salva?: LinhaDestino) => ({
          lancamento: origem.lancamento,
          numLct: origem.numLct,
          natureza: origem.natureza,
          valor: salva ? salva.valor : origem.valor,
          historico,
          ctaRed: salva?.ctaRed,
          desCta: salva?.desCta,
          codCcu: salva?.codCcu,
          desCcu: salva?.desCcu,
          numPrj: salva?.numPrj,
          nomPrj: salva?.nomPrj,
          codFpj: salva?.codFpj,
          desFpj: salva?.desFpj,
          gestor: salva?.gestor,
        })
      );
      destinos.forEach((d) => {
        if (d.ctaRed) {
          this.garantirProjetosCarregados(d.ctaRed);
          if (d.numPrj) {
            this.garantirSegmentoCarregado(d.ctaRed, d.numPrj);
          }
        }
      });
      return { origem, destinos };
    });
  }

  // Adiciona/remove destinos de um grupo (split 1 crédito -> N destinos,
  // pedido do usuário em 2026-10-14, mesmo padrão já usado no Manual pro
  // split 1 origem -> N destinos em 2026-09-02) — nunca deixa zerar
  // (sempre pelo menos 1 destino por grupo).
  adicionarDestino(grupo: GrupoDestino): void {
    grupo.destinos.push({
      lancamento: grupo.origem.lancamento,
      numLct: grupo.origem.numLct,
      natureza: grupo.origem.natureza,
      valor: undefined,
      historico: montarHistoricoDestino(this.dadosFormulario.numeroStc, grupo.origem.historico),
    });
  }

  removerDestino(grupo: GrupoDestino, index: number): void {
    if (grupo.destinos.length > 1) {
      grupo.destinos.splice(index, 1);
    }
  }

  totalDestinos(grupo: GrupoDestino): number {
    return grupo.destinos.reduce((total, d) => total + (d.valor ?? 0), 0);
  }

  saldoGrupo(grupo: GrupoDestino): number {
    return (grupo.origem.valor ?? 0) - this.totalDestinos(grupo);
  }

  // Tolerância de 0,005 pra ponto flutuante — mesmo padrão de
  // OrigemDestinoManualComponent.destinosBalanceados.
  grupoBalanceado(grupo: GrupoDestino): boolean {
    return Math.abs(this.saldoGrupo(grupo)) < 0.005;
  }

  todosGruposBalanceados(): boolean {
    return this.gruposDestino.every((g) => this.grupoBalanceado(g));
  }

  // Mesmo padrão do Manual (OrigemDestinoManualComponent): o bloqueio de
  // verdade é o botão "Avançar" desabilitado, não só a mensagem no clique —
  // confirmado necessário lá em 2026-09-02 (usuário reportou conseguir
  // avançar mesmo com saldo errado, usando só a mensagem). Usado em
  // destino.component.html pro modo Múltiplo.
  get multiploBloqueado(): boolean {
    const incompleta = this.gruposDestino.some((g) =>
      g.destinos.some((l) => !l.ctaRed || !l.codCcu || !l.numPrj || !l.codFpj || !l.valor)
    );
    return incompleta || !this.todosGruposBalanceados();
  }

  // Restaura o modo (Único/Múltiplo) e, no Único, o segmento único salvo
  // (mesmos campos que ficam "achatados" fora do array de linhas — ver
  // avancarEtapa). Patch roda com emitEvent:false (pra não disparar o reset
  // em cascata do valueChanges), então dispara a busca de Projeto/CC/Fase na
  // mão pros valores restaurados.
  private segmentoRestaurado = false;

  private restaurarModoEFormUnico(): void {
    if (this.dadosFormulario.modoDestino) {
      this.modo = this.dadosFormulario.modoDestino;
    }
    if (this.modo !== 'Unico' || !this.dadosFormulario.ctaRed) {
      return;
    }
    this.segmentoRestaurado = true;
    this.formUnico.patchValue(
      {
        ctaRed: this.dadosFormulario.ctaRed,
        codCcu: this.dadosFormulario.codCcu,
        numPrj: this.dadosFormulario.numPrj,
        codFpj: this.dadosFormulario.codFpj,
      },
      { emitEvent: false }
    );
    this.garantirProjetosCarregados(this.dadosFormulario.ctaRed);
    if (this.dadosFormulario.numPrj) {
      this.garantirSegmentoCarregado(this.dadosFormulario.ctaRed, this.dadosFormulario.numPrj);
    }
  }

  // Achado ao vivo em 2026-08-31 (mesmo padrão de
  // ModalidadeComponent.reaplicarRestauracao(), pedido do usuário: "no
  // destino, não está trazendo Projeto/Centro de Custo/Fase Destino"):
  // `restaurarModoEFormUnico()` seta o segmento no `formUnico` ANTES de
  // `getContasContabeis`/`getProjetosPorContas`/`getCCPorContas`/
  // `getFasesPorContas` (todos assíncronos, cascata) responderem — o
  // p-dropdown tenta casar o valor contra uma lista de `[options]` ainda
  // vazia (mesma causa raiz da Filial, já mitigada com
  // `[autoDisplayFirst]="false"`, mas sem uma reafirmação depois que a
  // lista carrega o valor pode simplesmente nunca ser exibido, mesmo sem o
  // autoDisplayFirst atrapalhar). Reforça os 4 campos de novo
  // (`emitEvent:false`) toda vez que qualquer nível da cascata termina de
  // carregar — chamado pelos 3 handlers de sucesso (`carregarListas()`/
  // `garantirProjetosCarregados()`/`garantirSegmentoCarregado()`). Só age
  // se houve algo pra restaurar (`segmentoRestaurado`) e ainda estamos no
  // modo Único.
  private reaplicarSegmentoDestinoRestaurado(): void {
    if (!this.segmentoRestaurado || this.modo !== 'Unico') {
      return;
    }
    this.formUnico.patchValue(
      {
        ctaRed: this.dadosFormulario.ctaRed,
        codCcu: this.dadosFormulario.codCcu,
        numPrj: this.dadosFormulario.numPrj,
        codFpj: this.dadosFormulario.codFpj,
      },
      { emitEvent: false }
    );
  }

  selecionarModo(modo: 'Unico' | 'Multiplo'): void {
    this.modo = modo;
  }

  // Só a Conta Contábil carrega de cara (lista cheia, sem endpoint de
  // filtro) — Projeto/CC/Fase agora carregam em cascata sob demanda (ver
  // garantirProjetosCarregados/garantirSegmentoCarregado), pedido do usuário
  // em 2026-08-29.
  carregarListas(): void {
    const codEmp = this.dadosFormulario.codEmp;
    if (!codEmp) {
      return;
    }
    this.carregando = true;
    this.servico.getContasContabeis(codEmp).subscribe({
      next: (contas) => {
        // Normaliza ctaRed pra string (pedido do usuário em 2026-08-31,
        // mesma classe de bug já vista em Empresa/Filial/Lote hoje) — o
        // valor restaurado de uma STC devolvida vem de variável de processo
        // do BPM, sempre string.
        this.contas = extrairLista<ContaContabil>(contas).map((c) => ({
          ...c,
          ctaRed: String(c.ctaRed),
        }));
        this.carregando = false;
        this.reaplicarSegmentoDestinoRestaurado();
      },
      error: () => {
        this.carregando = false;
        this.enviaMensagem.emit({
          tipo: 4,
          mensagem: 'Não foi possível carregar as Contas Contábeis.',
        });
      },
    });
  }

  private chaveSegmento(ctaRed: string, numPrj: string): string {
    return `${ctaRed}::${numPrj}`;
  }

  projetosDaConta(ctaRed: string | null | undefined): Projeto[] {
    return ctaRed ? this.projetosPorConta[ctaRed] ?? [] : [];
  }

  projetosCarregados(ctaRed: string | null | undefined): boolean {
    return !!ctaRed && !!this.projetosPorConta[ctaRed];
  }

  carregandoProjetos(ctaRed: string | null | undefined): boolean {
    return !!ctaRed && this.carregandoProjetosDe.has(ctaRed);
  }

  placeholderProjeto(ctaRed: string | null | undefined): string {
    if (!ctaRed) {
      return 'Selecione a conta primeiro';
    }
    return this.carregandoProjetos(ctaRed) ? 'Carregando projetos...' : 'Selecione o projeto';
  }

  // 1º nível da cascata (getProjetosPorContas) — dispara ao selecionar a
  // Conta Contábil Destino. Cache por ctaRed, compartilhado entre Único e
  // Múltiplo.
  garantirProjetosCarregados(ctaRed: string | null | undefined): void {
    const codEmp = this.dadosFormulario.codEmp;
    if (!ctaRed || !codEmp || this.projetosPorConta[ctaRed] || this.carregandoProjetosDe.has(ctaRed)) {
      return;
    }
    this.carregandoProjetosDe.add(ctaRed);
    this.servico.getProjetosPorContas(codEmp, ctaRed).subscribe({
      next: (retorno) => {
        // Normaliza numPrj pra string (defensivo, mesma cautela de sempre —
        // ver reaplicarSegmentoDestinoRestaurado() logo abaixo).
        this.projetosPorConta[ctaRed] = extrairLista<Projeto>(retorno).map((p) => ({
          ...p,
          numPrj: String(p.numPrj),
        }));
        this.carregandoProjetosDe.delete(ctaRed);
        this.reaplicarSegmentoDestinoRestaurado();
      },
      error: () => {
        this.carregandoProjetosDe.delete(ctaRed);
        this.enviaMensagem.emit({
          tipo: 4,
          mensagem: 'Não foi possível carregar os projetos da conta selecionada.',
        });
      },
    });
  }

  centrosCustoDoSegmento(
    ctaRed: string | null | undefined,
    numPrj: string | null | undefined
  ): CentroCusto[] {
    if (!ctaRed || !numPrj) {
      return [];
    }
    // Só CC com gestor (`usuRes`) cadastrado — sem isso, `usuarioGestorDestino`
    // fica `undefined` e o loop de aprovação do Gestor de Destino nunca roda
    // (BPM trava num erro de gateway). Reproduzido e confirmado pelo usuário
    // em 2026-08-27.
    return (this.segmentosPorProjeto[this.chaveSegmento(ctaRed, numPrj)]?.cc ?? []).filter(
      (c) => !!c.usuRes
    );
  }

  fasesDoSegmento(
    ctaRed: string | null | undefined,
    numPrj: string | null | undefined
  ): FaseProjeto[] {
    if (!ctaRed || !numPrj) {
      return [];
    }
    return this.segmentosPorProjeto[this.chaveSegmento(ctaRed, numPrj)]?.fases ?? [];
  }

  segmentoCarregado(ctaRed: string | null | undefined, numPrj: string | null | undefined): boolean {
    return !!ctaRed && !!numPrj && !!this.segmentosPorProjeto[this.chaveSegmento(ctaRed, numPrj)];
  }

  carregandoSegmento(ctaRed: string | null | undefined, numPrj: string | null | undefined): boolean {
    return (
      !!ctaRed && !!numPrj && this.carregandoSegmentoDe.has(this.chaveSegmento(ctaRed, numPrj))
    );
  }

  placeholderCC(ctaRed: string | null | undefined, numPrj: string | null | undefined): string {
    if (!ctaRed || !numPrj) {
      return 'Selecione o projeto primeiro';
    }
    return this.carregandoSegmento(ctaRed, numPrj)
      ? 'Carregando centros de custo...'
      : 'Selecione o centro de custo';
  }

  placeholderFase(ctaRed: string | null | undefined, numPrj: string | null | undefined): string {
    if (!ctaRed || !numPrj) {
      return 'Selecione o projeto primeiro';
    }
    return this.carregandoSegmento(ctaRed, numPrj) ? 'Carregando fases...' : 'Selecione a fase';
  }

  // 2º nível da cascata — dispara ao selecionar o Projeto Destino, busca
  // Centro de Custo (getCCPorContas) e Fase (getFasesPorContas) juntos, em
  // paralelo. Substitui o antigo getFasesProjeto (que só filtrava por
  // numPrj) nesta tela — o Manual (OrigemDestinoManualComponent) continua
  // usando getFasesProjeto, não foi alterado.
  garantirSegmentoCarregado(
    ctaRed: string | null | undefined,
    numPrj: string | null | undefined
  ): void {
    const codEmp = this.dadosFormulario.codEmp;
    if (!ctaRed || !numPrj || !codEmp) {
      return;
    }
    const chave = this.chaveSegmento(ctaRed, numPrj);
    if (this.segmentosPorProjeto[chave] || this.carregandoSegmentoDe.has(chave)) {
      return;
    }
    this.carregandoSegmentoDe.add(chave);
    forkJoin({
      cc: this.servico.getCCPorContas(codEmp, ctaRed, numPrj),
      fases: this.servico.getFasesPorContas(codEmp, ctaRed, numPrj),
    }).subscribe({
      next: ({ cc, fases }) => {
        // Normaliza codCcu/codFpj pra string (defensivo, mesma cautela de
        // sempre — ver reaplicarSegmentoDestinoRestaurado() logo abaixo).
        this.segmentosPorProjeto[chave] = {
          cc: extrairLista<CentroCusto>(cc).map((c) => ({ ...c, codCcu: String(c.codCcu) })),
          fases: extrairLista<FaseProjeto>(fases).map((f) => ({
            ...f,
            codFpj: String(f.codFpj),
          })),
        };
        this.carregandoSegmentoDe.delete(chave);
        this.reaplicarSegmentoDestinoRestaurado();
      },
      error: () => {
        this.carregandoSegmentoDe.delete(chave);
        this.enviaMensagem.emit({
          tipo: 4,
          mensagem: 'Não foi possível carregar Centro de Custo/Fase do projeto selecionado.',
        });
      },
    });
  }

  // Modo Múltiplo: cada linha (rateio) tem sua própria Conta, então o filtro
  // em cascata (ver garantirProjetosCarregados/garantirSegmentoCarregado) é
  // por linha — trocar a Conta daquela linha zera Projeto/CC/Fase dela e
  // busca os projetos da conta escolhida. Confirmado pelo cliente em
  // 2026-08-26: cada RATEIO pode ir pra um destino diferente (não é mais
  // agrupado por lançamento).
  aoTrocarContaLinha(linha: LinhaDestino, ctaRed: string | null): void {
    linha.ctaRed = ctaRed ?? undefined;
    linha.numPrj = undefined;
    linha.codCcu = undefined;
    linha.codFpj = undefined;
    if (ctaRed) {
      this.garantirProjetosCarregados(ctaRed);
    }
  }

  aoTrocarProjetoLinha(linha: LinhaDestino, numPrj: string | null): void {
    linha.numPrj = numPrj ?? undefined;
    linha.codCcu = undefined;
    linha.codFpj = undefined;
    if (numPrj && linha.ctaRed) {
      this.garantirSegmentoCarregado(linha.ctaRed, numPrj);
    }
  }

  // Gestor do destino = usuRes do Centro de Custo selecionado — confirmado
  // pelo usuário em 2026-08-17 (a Origem, no Por Lote, já vem com gestor
  // pronto do próprio lote/lançamento do ERP; o Destino é escolhido pelo
  // usuário, então não tem gestor pronto — resolve pelo Centro de Custo).
  private resolverDescricoes(linha: LinhaDestino): LinhaDestino {
    const conta = this.contas.find((c) => c.ctaRed === linha.ctaRed);
    const centro = this.centrosCustoDoSegmento(linha.ctaRed, linha.numPrj).find(
      (c) => c.codCcu === linha.codCcu
    );
    const projeto = this.projetosDaConta(linha.ctaRed).find((p) => p.numPrj === linha.numPrj);
    const fase = this.fasesDoSegmento(linha.ctaRed, linha.numPrj).find(
      (f) => f.codFpj === linha.codFpj
    );
    return {
      ...linha,
      desCta: conta?.desCta,
      desCcu: centro?.desCcu,
      nomPrj: projeto?.nomPrj,
      desFpj: fase?.desFpj,
      gestor: centro?.usuRes,
    };
  }

  avancarEtapa(): void {
    let linhasFinais: LinhaDestino[];

    if (this.modo === 'Unico') {
      if (this.formUnico.invalid) {
        this.formUnico.markAllAsTouched();
        this.enviaMensagem.emit({
          tipo: 3,
          mensagem: 'Preencha o segmento contábil de destino antes de avançar.',
        });
        return;
      }
      const segmento = this.resolverDescricoes(this.formUnico.getRawValue());
      linhasFinais = this.linhasDestino.map((linha) => ({ ...linha, ...segmento }));

      // Espelha o segmento "achatado" no Formulario (fora do array de linhas) —
      // só faz sentido no modo Único, onde existe um segmento só. No Múltiplo
      // cada linha pode ser diferente, então esses campos ficam vazios de propósito.
      this.servico.dadosFormulario.ctaRed = segmento.ctaRed;
      this.servico.dadosFormulario.desCta = segmento.desCta;
      this.servico.dadosFormulario.codCcu = segmento.codCcu;
      this.servico.dadosFormulario.desCcu = segmento.desCcu;
      this.servico.dadosFormulario.numPrj = segmento.numPrj;
      this.servico.dadosFormulario.nomPrj = segmento.nomPrj;
      this.servico.dadosFormulario.codFpj = segmento.codFpj;
      this.servico.dadosFormulario.desFpj = segmento.desFpj;
    } else {
      const incompleta = this.gruposDestino.some((g) =>
        g.destinos.some((l) => !l.ctaRed || !l.codCcu || !l.numPrj || !l.codFpj || !l.valor)
      );
      if (incompleta) {
        this.enviaMensagem.emit({
          tipo: 3,
          mensagem: 'Preencha o segmento contábil e o valor de destino em todas as linhas.',
        });
        return;
      }
      // Split 1 crédito -> N destinos (pedido do usuário em 2026-10-14): a
      // soma dos destinos de cada grupo precisa bater exatamente com o
      // valor do crédito original — "o saldo tem que ser igual", mesma
      // regra já confirmada no split do Manual (02/09).
      if (!this.todosGruposBalanceados()) {
        const grupoDivergente = this.gruposDestino.find((g) => !this.grupoBalanceado(g));
        this.enviaMensagem.emit({
          tipo: 3,
          mensagem: `A soma dos destinos do lançamento ${grupoDivergente?.origem.lancamento} (R$ ${this.totalDestinos(
            grupoDivergente!
          ).toFixed(2)}) precisa ser igual ao valor do crédito original (R$ ${(
            grupoDivergente?.origem.valor ?? 0
          ).toFixed(2)}).`,
        });
        return;
      }
      linhasFinais = this.gruposDestino.flatMap((g) =>
        g.destinos.map((linha) => this.resolverDescricoes(linha))
      );
    }

    // Fila de aprovação por gestor de destino (RN046/049/050, implementado em
    // 2026-08-22): um gestor por CC distinto entre as linhas, loop na etapa
    // gestor-destino do BPM até todos decidirem — ver AprovacaoComponent e
    // ServiceBpmService. No modo Único a fila sempre tem 1 gestor (loop de
    // uma passada só, mesmo comportamento de antes). Reseta o histórico e as
    // flags de loop toda vez que se sai desta tela — se o STCMO devolveu e o
    // solicitante corrigiu o destino, o loop de gestor-destino (que só roda
    // depois do STCMO) começa do zero, o que é o comportamento certo.
    const gestores = gestoresDistintos(linhasFinais);
    this.servico.dadosFormulario.usuarioGestorDestino = gestores[0];
    this.servico.dadosFormulario.pareceresGestorDestino = [];
    this.servico.dadosFormulario.aprovadoGestorDestino = undefined;
    this.servico.dadosFormulario.temProximoGestorDestino = undefined;

    this.servico.dadosFormulario.linhasDestino = linhasFinais;
    this.servico.dadosFormulario.modoDestino = this.modo;
    this.servico.dadosFormulario.tipoAcao = 'Seguir Processo';
    this.proximaEtapa.emit();
  }

  voltarEtapa(): void {
    this.voltar.emit();
  }
}
