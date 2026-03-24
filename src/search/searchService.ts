import { config } from "../config";
import { searchRawStorage } from "../storage/rawStorage";

export type SearchResult = {
  relevant_url: string;
  origin_url: string;
  depth: number;
};

export class SearchService {
  constructor(private readonly storagePath = config.rawStoragePath) {}

  async search(query: string, limit?: number): Promise<SearchResult[]> {
    const results = await searchRawStorage(this.storagePath, query);
    const limited = limit === undefined ? results : results.slice(0, limit);

    return limited.map((result) => ({
      relevant_url: result.relevant_url,
      origin_url: result.origin_url,
      depth: result.depth
    }));
  }
}
