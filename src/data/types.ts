export type TalkData = {
  generatedAt?: string;
  totals: { acts: number; commits: number; requests: number };
  dateRange: {
    first: string;
    last: string;
    firstEnactYear: number;
    lastEnactYear: number;
  };
  byYear: { types: string[]; rows: { year: number; type: string; count: number }[] };
  refsByYear: { year: number; mean: number; median: number; max: number; count: number }[];
  refDist: { bucket: string; count: number }[];
  dlOutcomes: { year: number; convertito: number; decaduto: number }[];
  caseStudies?: { octopus1925?: { code: string; degree: number } };
};

export type GraphNode = {
  id: string;
  degree: number;
  x: number;
  y: number;
  comp: string;
  compR: number;
  label?: string;
  hub?: number;
  unresolved?: boolean;
};

export type GraphEdge = { source: string; target: string };

export type GraphData = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type ActMeta = {
  slug: string;
  label?: string;
  enactDate: string | null;
  enactYear: number | null;
  decadutoDate: string | null;
  degree?: number;
  hub?: boolean;
};

export type ActsIndex = {
  asOf?: string;
  acts: ActMeta[];
};

export type BlameEntry = {
  date: string;
  subject: string;
  kind: "gu" | "modifica" | "decaduto" | "convertito" | "other";
};

export type BlameFile = {
  slug: string;
  entries: BlameEntry[];
};

export type Manifest = {
  asOf: string;
  generatedAt: string;
  artifacts: string[];
};

export type RagDoc = {
  id: string;
  slug: string;
  label: string;
  excerpt: string;
  embedding: number[];
};
