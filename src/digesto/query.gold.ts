import type { QuerySpec } from "./query";

export type GoldItem = {
  id: number;
  turns: string[];
  spec: QuerySpec;
};

export const GOLD: GoldItem[] = [
  {
    id: 1,
    turns: ["Monarchia o Repubblica: dove sono state emanate più leggi?"],
    spec: {
      intent: "compare",
      eras: ["monarchy", "republic"],
      measure: "LEGGE",
    },
  },
  {
    id: 2,
    turns: ["Which government status delivered more laws: monarchy or republic?"],
    spec: {
      intent: "compare",
      eras: ["monarchy", "republic"],
      measure: "LEGGE",
    },
  },
  {
    id: 3,
    turns: ["Quanti decreti durante la Repubblica?"],
    spec: { intent: "count", eras: ["republic"], measure: "decreti_bare" },
  },
  {
    id: 4,
    turns: ["How many decrees have been delivered during the republic?"],
    spec: { intent: "count", eras: ["republic"], measure: "decreti_bare" },
  },
  {
    id: 5,
    turns: ["Quante leggi nella Seconda Repubblica?"],
    spec: { intent: "count", eras: ["second_rep"], measure: "LEGGE" },
  },
  {
    id: 6,
    turns: ["How many laws have been produced during the second republic?"],
    spec: { intent: "count", eras: ["second_rep"], measure: "LEGGE" },
  },
  {
    id: 7,
    turns: ["Quanti regi decreti sotto la Repubblica?"],
    spec: { intent: "count", eras: ["republic"], measure: "REGIO DECRETO" },
  },
  {
    id: 8,
    turns: ["How many regio decreto have been produced under the republic?"],
    spec: { intent: "count", eras: ["republic"], measure: "REGIO DECRETO" },
  },
  {
    id: 9,
    turns: ["Quante leggi sotto la monarchia?"],
    spec: { intent: "count", eras: ["monarchy"], measure: "LEGGE" },
  },
  {
    id: 10,
    turns: ["Quanti atti nel corpus?"],
    spec: { intent: "count", eras: [], measure: "all" },
  },
  {
    id: 11,
    turns: ["In Repubblica, ha prodotto di più il parlamento o il governo?"],
    spec: { intent: "compare", eras: ["republic"], measure: "channels" },
  },
  {
    id: 12,
    turns: ["In the republic, who produced more: parliament or government?"],
    spec: { intent: "compare", eras: ["republic"], measure: "channels" },
  },
  {
    id: 13,
    turns: ["Quanti decreti-legge dal 1990?"],
    spec: { intent: "count", eras: [], measure: "DECRETO-LEGGE", from: 1990 },
  },
  {
    id: 14,
    turns: ["Quanti D.P.R. nella Prima Repubblica?"],
    spec: {
      intent: "count",
      eras: ["first_rep"],
      measure: "DECRETO DEL PRESIDENTE DELLA REPUBBLICA",
    },
  },
  {
    id: 15,
    turns: ["Quanti atti durante il fascismo?"],
    spec: { intent: "count", eras: ["fascism"], measure: "all" },
  },
  {
    id: 16,
    turns: ["Quanti decreti durante la Repubblica?", "e sotto la monarchia?"],
    spec: { intent: "count", eras: ["monarchy"], measure: "decreti_bare" },
  },
  {
    id: 17,
    turns: ["Quante leggi nella Prima Repubblica?"],
    spec: { intent: "count", eras: ["first_rep"], measure: "LEGGE" },
  },
  {
    id: 18,
    turns: ["How many acts under the monarchy?"],
    spec: { intent: "count", eras: ["monarchy"], measure: "all" },
  },
  {
    id: 19,
    turns: ["Quante leggi tra il 1970 e il 1980?"],
    spec: { intent: "count", eras: [], measure: "LEGGE", from: 1970, to: 1980 },
  },
  {
    id: 20,
    turns: ["How many laws?"],
    spec: { intent: "count", eras: [], measure: "LEGGE" },
  },
];
