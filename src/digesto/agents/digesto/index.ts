import agent from "./agent";
import mapUrl from "./map.png";

export { agent, mapUrl };

export const digestoLoaders = {
  agent: async () => ({ default: agent }),
  map: async () => ({ default: mapUrl }),
};
