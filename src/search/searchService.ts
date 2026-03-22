import { Database } from "sqlite";
import sqlite3 from "sqlite3";
import { tokenize } from "../crawler/parser";

export type SearchResult = {
  relevant_url: string;
  origin_url: string;
  depth: number;
};

export class SearchService {
  constructor(private readonly db: Database<sqlite3.Database, sqlite3.Statement>) {}

  async search(query: string, limit?: number): Promise<SearchResult[]> {
    const terms = Array.from(tokenize(query).keys());
    if (terms.length === 0) {
      return [];
    }

    const placeholders = terms.map(() => "?").join(",");
    const sql = `
      SELECT p.url as relevant_url,
             jp.origin_url as origin_url,
             jp.depth as depth,
             SUM(pt.frequency) as score
      FROM terms t
      JOIN page_terms pt ON pt.term_id = t.id
      JOIN pages p ON p.id = pt.page_id
      JOIN job_pages jp ON jp.page_id = p.id AND jp.job_id = pt.job_id
      WHERE t.term IN (${placeholders})
      GROUP BY p.url, jp.origin_url, jp.depth
      ORDER BY score DESC
    `;

    const rows = limit === undefined
      ? await this.db.all<any[]>(sql, ...terms)
      : await this.db.all<any[]>(`${sql}\n      LIMIT ?`, ...terms, limit);

    return rows.map((row) => ({
      relevant_url: row.relevant_url,
      origin_url: row.origin_url,
      depth: row.depth
    }));
  }
}
