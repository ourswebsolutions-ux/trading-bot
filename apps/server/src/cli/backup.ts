import { loadConfig } from '../config.js'
import { openDatabase } from '../db/sqlite.js'
import { backupNow } from '../services/backup.js'

const config = loadConfig()
const db = openDatabase(config.dbPath)
const target = backupNow(db, { backupDir: config.backupDir, uploadDir: config.uploadDir, retention: config.backupRetention })
console.log(`Backup written to ${target}`)
db.close()
