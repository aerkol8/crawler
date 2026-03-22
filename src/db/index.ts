import sqlite3 from "sqlite3";
import { open, Database } from "sqlite";
import { config } from "../config";
import { schemaSql } from "./schema";

let dbPromise: Promise<Database<sqlite3.Database, sqlite3.Statement>> | null = null;

export async function getDb() {
  if (!dbPromise) {
    dbPromise = open({
      filename: config.dbPath,
      driver: sqlite3.Database
    });
    const db = await dbPromise;
    await db.exec("PRAGMA journal_mode = WAL;");
    await db.exec("PRAGMA synchronous = NORMAL;");
    await db.exec("PRAGMA foreign_keys = ON;");
    await db.exec(schemaSql);
  }
  return dbPromise;
}
