import type { Messages } from "./types";

export const en: Messages = {
  brand: { name: "Normoscopio" },
  boot: {
    loading: "Loading…",
    scrollPrep: "Preparing scroll…",
  },
  app: {
    errorRefreshHint: "Run npm run refresh with LAWS_REPO set.",
  },
  hero: {
    title: "Italian law, in motion",
    lede: "{count} acts from 1861 to today. Scroll.",
    asOf: "Data as of {asOf}",
  },
  scrolly: { ariaLabel: "Narrative" },
  chart: {
    ariaLabel: "Acts per year, shaped by the narrative",
    captionVolume: "Acts per year · total volume",
    captionChannels: "Share per year · 100%",
    whisperLabel: "Whisper",
    whisperPending: "Digesto is counting…",
    tipActs: "{count} acts",
    tipShare: "{label}: {pct}% · {count}",
    refsMean: "mean refs",
    eras: {
      unita: "Unification",
      fascismo: "Fascism",
      repubblica: "Republic",
      seconda: "2nd Rep.",
    },
    story: {
      dl112: "D.L. 112/2008",
      dlgs179: "D.Lgs. 179/2009",
    },
    channels: {
      parlamento: "Parliament (statutes)",
      governo: "Government / executive (decrees)",
      altro: "Other (R.D., D.P.R., …)",
    },
  },
  explore: {
    ariaLabel: "Explore the graph",
    title: "Explore",
    lede: "A network of amendments. Filter by enactment date — without calling anything “in force”.",
    graphNote:
      "Not the whole corpus: only connected components of at least {minComp} acts linked by amendments ({nodes} nodes out of {corpus}). The rest — about {omitted} acts — lack enough references to form a cluster worth rendering here.",
    loadingGraph: "Loading graph…",
    loadingNetwork: "Loading the amendment network…",
    updatingNetwork: "Updating network…",
    fitGraph: "Fit all",
    remix: "Remix the volume chart",
    remixAria: "Remix the bar chart for this section",
    remixHint: "A playground on the bar chart: log scale, types, eras, annotations.",
    remixTitle: "Remix · Acts per year",
    remixLog: "log scale",
    remixLinear: "linear scale",
    remixAll: "all acts",
    remixLegge: "statutes only",
    remixGoverno: "decrees only",
    remixChannels: "channels",
    remixShare: "100% stack",
    remixCluster: "annotate selected cluster",
    remixStory112: "D.L. 112/2008",
    remixStory179: "D.Lgs. 179/2009",
    blameHint:
      "{count} acts with a timeline (light ring). Click a ringed node to open it.",
    blameNode: "Click: opens the timeline",
  },
  timeBrush: {
    label: "Enacted by {year} · not lapsed",
    counts: "{nodes} nodes · {edges} edges",
    ariaLabel: "Enacted by {year}, not lapsed",
    transportAria: "Year playback",
    play: "Play",
    pause: "Pause",
    forward10: "Forward 10 years",
    back10: "Back 10 years",
  },
  revision: {
    title: "Timeline",
    loading: "Loading…",
    missing: "Timeline not available for this act.",
    printAria: "Revision spiral, one step per version, colour by era",
    caption: "{versions} versions · degree {degree} · {span}",
    captionHub: "{versions} versions · hub (degree {degree}) · {span}",
    captionHint: "Hover the dates: the spiral reaches that version.",
    excerptLabel: "From the Gazzetta text (excerpt, not the whole history)",
    excerptMissing:
      "The full text is not on this page. What remains is the version register.",
    summaryLabel: "What the act is about",
    summaryPending: "Digesto is summarizing…",
    changesLabel: "What changed",
    arc: "From {first} to {last}: {modifiche} amendments ({eraBits}).",
    arcNone: "A single version on file, {year}.",
    arcLapsed: "Lapsed in {decaduto}.",
    arcEra: {
      unita: "{n} in Unification",
      fascismo: "{n} under fascism",
      repubblica: "{n} in the Republic",
      seconda: "{n} in the Second Republic",
    },
    epithetFallback: "hub of {year}",
    kind: {
      gu: "Publication",
      modifica: "Amendment",
      decaduto: "Lapsed",
      convertito: "Conversion",
      other: "Other",
    },
  },
  theme: {
    ariaLabel: "Theme",
    system: "Auto",
    systemTitle: "Match system",
    light: "Light",
    lightTitle: "Light theme",
    dark: "Dark",
    darkTitle: "Dark theme",
  },
  locale: {
    ariaLabel: "Language",
    it: "IT",
    en: "EN",
  },
  common: {
    close: "Close",
    loading: "Loading…",
    error: "Error",
  },
  digesto: {
    name: "Digesto",
    hostAria: "Digesto assistant",
    agentAria: "Digesto, assistant",
    historyLabel: "Questions",
    placeholder: "Ask the corpus…",
    submit: "Send",
    greeting: "Yes?",
    unsupported: "This device does not support any available model.",
    welcome:
      "On-device chat in the browser — nothing leaves your device.\n\nChoose a local model to download.",
    welcomeChoose:
      "On-device chat — nothing leaves your device.\n\nChoose a local model:",
    choiceNative: "{model}",
    choiceNativeHint: "Built into the browser · ~4 GB+ first download",
    choiceSizeHint: "~{size} MB download · runs in the browser (WASM)",
    loadingModel: "Loading local model…",
    loadingPct: "Loading local model {pct}%",
    loadingNativePct: "Downloading {model}… {pct}%",
    loadingNative: "Downloading {model}… this can take a while",
    readyAsk:
      "Ready. On-device chat — nothing leaves your device. Ask me facts about the corpus.",
    readySpeak:
      "Ready ({model}). On-device chat — nothing leaves your device. E.g. “How many laws under the monarchy?”",
    thinking: "…",
    privacy:
      "Local model in the browser: chat data does not leave your device.",
    disclaimer:
      "It can be wrong. This is not legal advice and not a substitute for official sources.",
    systemPrompt: `You are Digesto on Normoscopio.
Answer in English, 1–2 dry sentences.
Use only the FACTS listed below. Report numbers as given.
Do not repeat these instructions. Do not say “None of the numbers”.
Do not give personal legal advice.`,
    refuseAdvice:
      "I cannot give personal legal advice. Ask for facts or texts from the corpus.",
    unclearAnswer: "I could not form a clear answer from the data.",
    engineNotReady: "Engine not ready",
    noModel: "This device does not support any available model.",
    progressLocal: "Loading local model…",
    progressLocalPct: "Loading local model {pct}%",
    sourcesDev: "Sources (dev)",
    cannedUnknown:
      "I didn’t catch that. Try an era (monarchy, Republic, Second Republic) and a type (laws, decrees, royal decrees), or parliament vs government.",
    exampleQuestions: [
      "Which government status delivered more laws: monarchy or republic?",
      "How many decrees have been delivered during the republic?",
      "How many laws have been produced during the second republic?",
      "How many regio decreto have been produced under the republic?",
    ],
    sveglia:
      "I can follow the numbers. One tap downloads the model in the browser (~4 GB). Nothing leaves this device.",
    svegliaNative: "Wake me · {model} · ~4 GB",
    invite:
      "Ready. This is not legal advice: only the corpus counts. Start again from 1861 if you want me along.",
    restart: "Start again from 1861",
    cues: {
      archivio: "Over {span} years, {perYear} acts a year on average. {peakYear} is the visible peak, not the rhythm.",
      volume: "{peakYear} weighs {peakCount} acts: about {peakRatio} times {quietYear} ({quietCount}).",
      tipi: "Only {leggePct}% are statutes. The rest of the volume is royal and executive decrees.",
      regi: "One act in {regiOneIn} on file is still a royal decree: {regiPct}%.",
      epoche: "Fascism is {fascismPct}% of the corpus. Unification {unita}; from 1990, {secondRep}.",
      repubblica: "From 1946: {republic} acts, {republicPct}% of the corpus. The volume peak remains {peakYear}.",
      urgenze: "One act in {govOneIn} is an executive decree ({decretiPct}% of volume).",
      legami: "Each new act cites {refs} older norms on average. The maximum is {peakRefsYear}.",
      rete: "In {peakRefsYear} mean refs reach {peakRefs}: that is where the net thickens.",
      taglio: "From 2008 to 2009 volume drops by {deltaAbs} acts a year. Two hubs, one cut in the books.",
      memoria: "{dlLapsePct}% of decree-laws lapse without conversion. The register still keeps them.",
      canali: "Parliament {leggePct}%, executive {decretiPct}%. The 100% stack shows who writes, not how much.",
      close: "Ringed nodes have a timeline. The others stay shape in the graph.",
    },
    whispers: {
      archivio: "{perYear} a year over {span} years; peak {peakYear}.",
      volume: "{peakYear} is {peakRatio}× {quietYear}.",
      tipi: "Statutes only {leggePct}%; the rest is executive and royal.",
      regi: "One act in {regiOneIn} is royal.",
      epoche: "Fascism: {fascismPct}% of the corpus.",
      repubblica: "From 1946: {republicPct}% of the corpus.",
      urgenze: "One act in {govOneIn} is executive.",
      legami: "Mean {refs} refs per new act.",
      rete: "Densest net in {peakRefsYear} ({peakRefs}).",
      taglio: "2008→2009: −{deltaAbs} acts a year.",
      memoria: "{dlLapsePct}% of DL lapse without conversion.",
      canali: "Who writes: parliament {leggePct}%, executive {decretiPct}%.",
      close: "Only ringed nodes open a timeline.",
    },
  },
  gazzetta: {
    ariaLabel: "Personal gazette",
    title: "Personal gazette",
    lede: "One year of the archive. Not the laws that apply to you: how much the state wrote.",
    kicker: "Official gazette · personal extract",
    yearLabel: "Year",
    sealArchive: "Archive only",
    mixLabel: "Who writes",
    featured: "Featured act",
    featuredMeta: "{date} · {degree} graph refs · {hubs} hubs that year",
    featuredNone: "No indexed node for this year.",
    volumeCaption: "Volume around the year",
    asOf: "Corpus {corpus} acts · as of {asOf}",
    archiveNote: "This sheet is an archival extract. It is not advice and does not say what is in force.",
    rubricaPending: "Digesto is writing the caption…",
    canned:
      "In {year} the state put {total} acts in the Gazzetta (corpus mean: {corpusMean} a year). Parliament {parlamento}, executive {governo}.",
    cannedFeatured:
      "In {year} the state put {total} acts in the Gazzetta (corpus mean: {corpusMean} a year). Parliament {parlamento}, executive {governo}. The most cited indexed node is {featured} ({degree} refs).",
    vsMeanUp: "+{pct}% vs mean",
    vsMeanDown: "{pct}% vs mean",
    vsMeanFlat: "near the mean",
    dlLine: "Decree-laws: {dlConvertito} converted, {dlDecaduto} lapsed ({dlLapsePct}% without conversion).",
    souvenir: "Want a souvenir?",
  },
  steps: {
    archivio: {
      headline: "An archive that grows",
      body: [
        "Since 1861 the Italian state has written law almost every day.",
        "Here we do not read texts one by one: we count acts, year after year.",
      ],
    },
    volume: {
      headline: "How much law there is",
      body: [
        "The chart profile is legislative output: war peaks, reconstruction, reforms.",
        "Each bar is a year. Height is how many acts enter the Gazzetta.",
      ],
    },
    tipi: {
      headline: "Not all norms are equal",
      body: [
        "Statutes, presidential decrees, royal decrees, decree-laws: different tools, same columns.",
        "Colors separate families. The same year can be rich in one type and poor in another.",
      ],
    },
    regi: {
      headline: "The weight of the past",
      body: [
        "For decades royal decrees dominate the volume.",
        "Modern Italian law also grows from a sea of monarchical acts still cited and amended today.",
      ],
    },
    epoche: {
      headline: "Four eras, one line",
      body: [
        "Unification, fascism, Republic, Second Republic: not just schoolbook labels.",
        "On the chart, rhythm and mix change. Vertical lines mark the turns.",
      ],
    },
    repubblica: {
      headline: "After 1946",
      body: [
        "With the Republic the mix shifts: more statutes and legislative decrees; royal decrees vanish with the monarchy.",
        "The past stays in the background. The present takes the foreground.",
      ],
    },
    urgenze: {
      headline: "Urgency has a shape",
      body: [
        "Decree-laws are born for necessity and urgency. They expire: converted or lapsed.",
        "Not everything that enters the Gazzetta stays standing.",
      ],
    },
    legami: {
      headline: "Laws change over time",
      body: [
        "An act can cite or amend another. Law is not a list: it is a network.",
        "The line above the bars shows, on average, how much each new act “touches” the rest.",
      ],
    },
    rete: {
      headline: "A denser network",
      body: [
        "Over time references grow: more text, more cross-links, more amendments.",
        "A few hubs — a handful of norms — gather thousands of links.",
      ],
    },
    taglio: {
      headline: "A cut, a restoration",
      body: [
        "In 2008 D.L. 112 repeals in bulk. The next year D.Lgs. 179 restores pieces.",
        "Two acts, two nodes. On the chart: 2008 and 2009 stay lit.",
      ],
    },
    memoria: {
      headline: "Even repeal leaves a trace",
      body: [
        "Deleting a norm does not delete history: the text remains, the links remain, the dates remain.",
        "The archive exists for this: to see what was there, not only what is.",
      ],
    },
    canali: {
      headline: "Two channels, one archive",
      body: [
        "From Kingdom to Republic: Parliament votes statutes; the executive, for urgency or by delegation, produces decrees (today D.L. and D.Lgs.; earlier royal decree-laws and lieutenant decrees).",
        "On the chart, the full timeline: not only how much law there is — who puts it in the Gazzetta. The rest stays in the background.",
      ],
    },
    close: {
      headline: "Then you explore",
      body: [
        "On desktop, below, a browser-sized slice of the amendment network (connected clusters): filter by year, open an act’s timeline.",
        "On a phone the story remains. The assistant, if the device supports it, answers on the corpus.",
      ],
    },
  },
};
