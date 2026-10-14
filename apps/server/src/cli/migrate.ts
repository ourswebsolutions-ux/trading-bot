import { loadConfig } from '../config.js'
import { migrate, openDatabase } from '../db/sqlite.js'

const config = loadConfig()
const db = openDatabase(config.dbPath)
const ran = migrate(db)
console.log(ran.length ? `Applied migrations: ${ran.join(', ')}` : 'Database is up to date')
db.close()
