package database

import (
	"context"
	"database/sql"
	"log"
	"time"

	"modernc.org/sqlite"
)

type DB struct {
	dbPath string
	Read *sql.DB
	Write *sql.DB
}

const initSQL = `
	PRAGMA journal_mode = WAL;
	PRAGMA synchronous = NORMAL;
	PRAGMA temp_store = MEMORY;
	PRAGMA mmap_size = 30000000000; -- 30GB
	PRAGMA busy_timeout = 5000;
	PRAGMA automatic_index = true;
	PRAGMA foreign_keys = ON;
	PRAGMA analysis_limit = 1000;
	PRAGMA trusted_schema = OFF;
`

func New(ctx context.Context, dbPath string) (db *DB, err error) {
	db = &DB{
		dbPath: dbPath,
	}

	// make sure every opened connection has the settings we expect
	sqlite.RegisterConnectionHook(func(conn sqlite.ExecQuerierContext, _ string) error {
		_, err = conn.ExecContext(ctx, initSQL, nil)

		return err
	})

	write, err := sql.Open("sqlite", "file:"+db.dbPath)
	if err != nil {
		return
	}
	// only a single writer ever, no concurrency
	write.SetMaxOpenConns(1)
	write.SetConnMaxIdleTime(time.Minute)
	if err != nil {
		return
	}

	read, err := sql.Open("sqlite", "file:"+db.dbPath)
	if err != nil {
		return
	}
	// readers can be concurrent
	read.SetMaxOpenConns(100)
	read.SetConnMaxIdleTime(time.Minute)

	db.Read = read
	db.Write = write

	return
}

const createTableSQL = `
	CREATE TABLE IF NOT EXISTS users (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		google_id TEXT NOT NULL UNIQUE,
		clipboard TEXT NOT NULL DEFAULT ''
	);

	CREATE TABLE IF NOT EXISTS sessions (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER NOT NULL,
		token TEXT NOT NULL,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY(user_id) REFERENCES users(id)
	);
`

func Init(db *DB) {
	_, err := db.Write.Exec(createTableSQL)
	if err != nil {
		log.Fatal(err)
	}
}
