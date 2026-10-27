import type { Messages } from "./types";

export const it: Messages = {
  brand: { name: "OpenNorme" },
  boot: {
    loading: "Caricamento…",
    scrollPrep: "Preparazione scorrimento…",
  },
  app: {
    errorRefreshHint: "Esegui npm run refresh con LAWS_REPO impostato.",
  },
  hero: {
    title: "Il diritto italiano, in movimento",
    lede: "{count} atti dal 1861 a oggi. Scorri.",
    asOf: "Dati aggiornati al {asOf}",
  },
  scrolly: { ariaLabel: "Narrazione" },
  chart: {
    ariaLabel: "Atti per anno, arricchiti dalla narrazione",
    captionVolume: "Atti per anno · volume totale",
    captionChannels: "Quota per anno · 100%",
    whisperLabel: "Sussurro",
    whisperPending: "Digesto sta contando…",
    tipActs: "{count} atti",
    tipShare: "{label}: {pct}% · {count}",
    refsMean: "refs medi",
    eras: {
      unita: "Unità",
      fascismo: "Fascismo",
      repubblica: "Repubblica",
      seconda: "II Rep.",
    },
    story: {
      dl112: "D.L. 112/2008",
      dlgs179: "D.Lgs. 179/2009",
    },
    channels: {
      parlamento: "Parlamento (leggi)",
      governo: "Governo / esecutivo (decreti)",
      altro: "Altro (R.D., D.P.R., …)",
    },
  },
  explore: {
    ariaLabel: "Esplora il grafo",
    title: "Esplora",
    lede: "Rete di modifiche. Filtra per data di emanazione — senza dichiarare «vigente».",
    graphNote:
      "Non è tutto il corpus: solo le componenti connesse di almeno {minComp} atti legati da modifiche ({nodes} nodi su {corpus}). Il resto — circa {omitted} atti — non ha abbastanza riferimenti per un cluster utile in pagina.",
    loadingGraph: "Caricamento grafo…",
    loadingNetwork: "Caricamento della rete di modifiche…",
    updatingNetwork: "Aggiornamento rete…",
    fitGraph: "Inquadra tutto",
    remix: "Remix il volume",
    remixAria: "Remix il grafico a barre di questa sezione",
    remixHint: "Playground sul grafico a barre: scala log, tipi, epoche, annotazioni.",
    remixTitle: "Remix · Atti per anno",
    remixLog: "scala log",
    remixLinear: "scala lineare",
    remixAll: "tutti gli atti",
    remixLegge: "solo leggi",
    remixGoverno: "solo decreti",
    remixChannels: "canali",
    remixShare: "quota 100%",
    remixCluster: "annota cluster selezionato",
    remixStory112: "D.L. 112/2008",
    remixStory179: "D.Lgs. 179/2009",
    blameHint:
      "{count} atti con cronologia (anello chiaro). Clicca un nodo cerchiato per aprirla.",
    blameNode: "Clicca: apre la cronologia",
  },
  timeBrush: {
    label: "Emanate entro {year} · non decadute",
    counts: "{nodes} nodi · {edges} archi",
    ariaLabel: "Emanate entro {year}, non decadute",
    transportAria: "Riproduzione anni",
    play: "Play",
    pause: "Pausa",
    forward10: "Avanti 10 anni",
    back10: "Indietro 10 anni",
  },
  revision: {
    title: "Cronologia",
    loading: "Caricamento…",
    missing: "Cronologia non disponibile per questo atto.",
    printAria: "Spirale delle revisioni, un passo per versione, colore per epoca",
    caption: "{versions} versioni · grado {degree} · {span}",
    captionHub: "{versions} versioni · hub (grado {degree}) · {span}",
    captionHint: "Passa sulle date: la spirale arriva a quella versione.",
    excerptLabel: "Dal testo in Gazzetta (estratto, non l’intera storia)",
    excerptMissing:
      "Il testo integrale non è in pagina. Resta il registro delle versioni.",
    summaryLabel: "Di che si tratta",
    summaryPending: "Digesto sta sintetizzando…",
    changesLabel: "Cosa è cambiato",
    arc: "Dal {first} al {last}: {modifiche} modifiche ({eraBits}).",
    arcNone: "Una sola versione in archivio, {year}.",
    arcLapsed: "Decaduta nel {decaduto}.",
    arcEra: {
      unita: "{n} nell’Unità",
      fascismo: "{n} nel fascismo",
      repubblica: "{n} in Repubblica",
      seconda: "{n} nella Seconda Repubblica",
    },
    epithetFallback: "nodo del {year}",
    kind: {
      gu: "Pubblicazione",
      modifica: "Modifica",
      decaduto: "Decaduto",
      convertito: "Conversione",
      other: "Altro",
    },
  },
  theme: {
    ariaLabel: "Tema",
    system: "Auto",
    systemTitle: "Come il sistema",
    light: "Chiaro",
    lightTitle: "Tema chiaro",
    dark: "Scuro",
    darkTitle: "Tema scuro",
  },
  locale: {
    ariaLabel: "Lingua",
    it: "IT",
    en: "EN",
  },
  common: {
    close: "Chiudi",
    loading: "Caricamento…",
    error: "Errore",
  },
  digesto: {
    name: "Digesto",
    hostAria: "Assistente Digesto",
    agentAria: "Digesto, assistente",
    historyLabel: "Domande",
    placeholder: "Chiedi al corpus…",
    submit: "Invia",
    greeting: "Sì?",
    unsupported: "Questo dispositivo non supporta nessun modello disponibile.",
    welcome:
      "Chat locale nel browser — nulla esce dal dispositivo.\n\nScegli un modello locale da scaricare.",
    welcomeChoose:
      "Chat locale — nulla esce dal dispositivo.\n\nScegli un modello locale:",
    choiceNative: "{model}",
    choiceNativeHint: "Integrato nel browser · primo download ~4 GB+",
    choiceSizeHint: "download ~{size} MB · nel browser (WASM)",
    loadingModel: "Caricamento modello locale…",
    loadingPct: "Caricamento modello locale {pct}%",
    loadingNativePct: "Download di {model}… {pct}%",
    loadingNative: "Download di {model}… può richiedere tempo",
    readyAsk:
      "Pronto. Chat locale — nulla esce dal dispositivo. Chiedimi fatti sul corpus.",
    readySpeak:
      "Pronto ({model}). Chat locale — nulla esce dal dispositivo. Es. «Quante leggi sotto la monarchia?»",
    thinking: "…",
    privacy:
      "Modello locale nel browser: i dati della chat non escono dal tuo dispositivo.",
    disclaimer:
      "Può sbagliare. Non è consulenza legale né un sostituto di fonti ufficiali.",
    systemPrompt: `Sei Digesto su OpenNorme.
Rispondi in italiano, 1-2 frasi secche.
Usa solo i FATTI elencati sotto. Riporta i numeri così come sono.
Non ripetere queste istruzioni. Non dire «Nessuno dei numeri».
Non dare consigli legali personali.`,
    refuseAdvice:
      "Non posso dare consigli legali personali. Chiedi fatti o testi del corpus.",
    unclearAnswer: "Non sono riuscito a formulare una risposta chiara dai dati.",
    engineNotReady: "Motore non pronto",
    noModel: "Questo dispositivo non supporta nessun modello disponibile.",
    progressLocal: "Caricamento modello locale…",
    progressLocalPct: "Caricamento modello locale {pct}%",
    sourcesDev: "Fonti (dev)",
    cannedUnknown:
      "Non ho capito. Prova con un’epoca (monarchia, Repubblica, Seconda Repubblica) e un tipo (leggi, decreti, regi decreti), oppure parlamento contro governo.",
    exampleQuestions: [
      "Monarchia o Repubblica: dove sono state emanate più leggi?",
      "Quanti decreti durante la Repubblica?",
      "Quante leggi nella Seconda Repubblica?",
      "Quanti regi decreti sotto la Repubblica?",
    ],
    sveglia:
      "Posso seguirti nei numeri. Un tocco scarica il modello nel browser (~4 GB). Nulla esce da qui.",
    svegliaNative: "Svegliami · {model} · ~4 GB",
    invite:
      "Pronto. Non è consulenza: solo i conti del corpus. Ricomincia dal 1861 se vuoi che ti accompagni.",
    restart: "Ricomincia dal 1861",
    cues: {
      archivio: "In {span} anni, {perYear} atti l’anno in media. Il {peakYear} è il picco visibile, non il ritmo.",
      volume: "Il {peakYear} pesa {peakCount} atti: circa {peakRatio} volte il {quietYear} ({quietCount}).",
      tipi: "Solo {leggePct}% sono leggi. Il resto del volume è regi e decreti dell’esecutivo.",
      regi: "Un atto su {regiOneIn} in archivio è un regio decreto: ancora il {regiPct}%.",
      epoche: "Il fascismo è il {fascismPct}% del corpus. L’Unità {unita}; dal 1990, {secondRep}.",
      repubblica: "Dal 1946: {republic} atti, il {republicPct}% del corpus. Il picco di volume resta il {peakYear}.",
      urgenze: "Un atto su {govOneIn} è un decreto dell’esecutivo ({decretiPct}% del volume).",
      legami: "Ogni atto nuovo cita in media {refs} norme già scritte. Il massimo è il {peakRefsYear}.",
      rete: "Nel {peakRefsYear} i rinvii medi arrivano a {peakRefs}: lì la rete si infittisce.",
      taglio: "Dal 2008 al 2009 il volume perde {deltaAbs} atti l’anno. Due hub, un taglio nei conti.",
      memoria: "{dlLapsePct}% dei decreti-legge decadono senza conversione. Il registro resta.",
      canali: "Parlamento {leggePct}%, esecutivo {decretiPct}%. La quota 100% dice chi scrive, non quanto.",
      close: "I nodi cerchiati hanno una cronologia. Gli altri restano solo forma nel grafo.",
    },
    whispers: {
      archivio: "{perYear} l’anno per {span} anni; picco {peakYear}.",
      volume: "{peakYear} vale {peakRatio}× il {quietYear}.",
      tipi: "Leggi solo {leggePct}%; il resto è esecutivo e regi.",
      regi: "Un atto su {regiOneIn} è un regio.",
      epoche: "Fascismo: {fascismPct}% del corpus.",
      repubblica: "Dal 1946: {republicPct}% del corpus.",
      urgenze: "Un atto su {govOneIn} è dell’esecutivo.",
      legami: "In media {refs} rinvii per atto nuovo.",
      rete: "Rete più densa nel {peakRefsYear} ({peakRefs}).",
      taglio: "2008→2009: −{deltaAbs} atti l’anno.",
      memoria: "{dlLapsePct}% dei DL decade senza conversione.",
      canali: "Chi scrive: parlamento {leggePct}%, esecutivo {decretiPct}%.",
      close: "Solo i cerchiati aprono una cronologia.",
    },
  },
  gazzetta: {
    ariaLabel: "Gazzetta personale",
    title: "Gazzetta personale",
    lede: "Un anno dell’archivio. Non le norme che ti riguardano: quanto lo Stato ha scritto.",
    kicker: "Gazzetta ufficiale · estratto personale",
    yearLabel: "Anno",
    sealArchive: "Solo archivio",
    mixLabel: "Chi scrive",
    featured: "Atto in evidenza",
    featuredMeta: "{date} · {degree} rinvii nel grafo · {hubs} hub nell’anno",
    featuredNone: "Nessun nodo indicizzato per questo anno.",
    volumeCaption: "Volume intorno all’anno",
    asOf: "Corpus {corpus} atti · dati al {asOf}",
    archiveNote: "Questo foglio è un estratto d’archivio. Non è un parere e non dice cosa è in vigore.",
    rubricaPending: "Digesto sta componendo la rubrica…",
    canned:
      "Nel {year} lo Stato mette in Gazzetta {total} atti (media del corpus: {corpusMean} l’anno). Parlamento {parlamento}, esecutivo {governo}.",
    cannedFeatured:
      "Nel {year} lo Stato mette in Gazzetta {total} atti (media del corpus: {corpusMean} l’anno). Parlamento {parlamento}, esecutivo {governo}. Il nodo più citato tra gli atti indicizzati è {featured} ({degree} rinvii).",
    vsMeanUp: "+{pct}% vs media",
    vsMeanDown: "{pct}% vs media",
    vsMeanFlat: "in media",
    dlLine: "Decreti-legge: {dlConvertito} convertiti, {dlDecaduto} decaduti ({dlLapsePct}% senza conversione).",
    souvenir: "Vuoi un souvenir?",
  },
  steps: {
    archivio: {
      headline: "Un archivio che cresce",
      body: [
        "Dal 1861 lo Stato italiano scrive diritto quasi ogni giorno.",
        "Qui non leggiamo i testi uno per uno: contiamo gli atti, anno dopo anno.",
      ],
    },
    volume: {
      headline: "Quanto diritto c’è",
      body: [
        "Il profilo del grafico è la produzione normativa: picchi di guerra, ricostruzione, riforme.",
        "Ogni barra è un anno. L’altezza è quanti atti entrano in Gazzetta.",
      ],
    },
    tipi: {
      headline: "Non tutte le norme sono uguali",
      body: [
        "Leggi, decreti del Presidente, regî decreti, decreti-legge: strumenti diversi, stesse colonne.",
        "I colori separano le famiglie. Lo stesso anno può essere pieno di un tipo e povero di un altro.",
      ],
    },
    regi: {
      headline: "Il peso del passato",
      body: [
        "Per decenni i regî decreti dominano il volume.",
        "Il diritto italiano moderno nasce anche da un mare di atti monarchici ancora oggi citati e modificati.",
      ],
    },
    epoche: {
      headline: "Quattro epoche, una linea",
      body: [
        "Unità, fascismo, Repubblica, Seconda Repubblica: non sono solo etichette scolastiche.",
        "Sul grafico cambiano ritmo e composizione. Le linee verticali segnano i passaggi.",
      ],
    },
    repubblica: {
      headline: "Dopo il 1946",
      body: [
        "Con la Repubblica il mix si sposta: più leggi e decreti legislativi, i regî spariscono insieme alla monarchia.",
        "Il passato resta nello sfondo. Il presente occupa il primo piano.",
      ],
    },
    urgenze: {
      headline: "L’urgenza ha una forma",
      body: [
        "I decreti-legge nascono per necessità e urgenza. Hanno una scadenza: convertiti o decaduti.",
        "Non tutto ciò che entra in Gazzetta resta in piedi.",
      ],
    },
    legami: {
      headline: "Le leggi cambiano nel tempo",
      body: [
        "Un atto può citare o modificare un altro. Il diritto non è un elenco: è una rete.",
        "La linea sopra le barre mostra, in media, quanto ogni nuovo atto “tocca” il resto.",
      ],
    },
    rete: {
      headline: "Una rete che si addensa",
      body: [
        "Nel tempo i riferimenti crescono: più testo, più rinvii, più modifiche.",
        "Alcuni hub — poche norme — raccolgono migliaia di collegamenti.",
      ],
    },
    taglio: {
      headline: "Un taglio, un ripristino",
      body: [
        "Nel 2008 il D.L. 112 abroga in blocco. L’anno dopo il D.Lgs. 179 restituisce pezzi.",
        "Due atti, due nodi. Sul grafico: il 2008 e il 2009 restano accesi.",
      ],
    },
    memoria: {
      headline: "Anche l’abrogazione lascia traccia",
      body: [
        "Cancellare una norma non cancella la storia: resta il testo, restano i legami, restano le date.",
        "L’archivio serve proprio a questo: vedere cosa c’era, non solo cosa c’è.",
      ],
    },
    canali: {
      headline: "Due canali, un archivio",
      body: [
        "Dal Regno alla Repubblica: il Parlamento vota le leggi; l’esecutivo, per urgenza o per delega, produce decreti (oggi D.L. e D.Lgs.; ieri regî decreti-legge e luogotenenziali).",
        "Sul grafico tutta la linea del tempo: non solo quanto diritto c’è — chi lo fa entrare in Gazzetta. Il resto resta nello sfondo.",
      ],
    },
    close: {
      headline: "Poi si esplora",
      body: [
        "Sul desktop, sotto, una porzione della rete delle modifiche (cluster connessi, pensata per il browser): filtra per anno, apri la cronologia di un atto.",
        "Sul telefono resta la storia. L’assistente, se il dispositivo lo supporta, risponde sul corpus.",
      ],
    },
  },
};
