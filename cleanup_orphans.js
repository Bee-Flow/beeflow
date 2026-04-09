require('dotenv').config();
const { pool } = require('./db');

async function clean() {
    try {
        console.log("Checking for orphaned chunks...");
        const result = await pool.query(`
            DELETE FROM kb_chunks 
            WHERE document_id NOT IN (SELECT id::text FROM documents)
            RETURNING id, document_id, title;
        `);
        console.log(`Deleted ${result.rowCount} orphaned chunks.`);
        // Just print a breakdown of deleted chunks
        const titles = new Set();
        result.rows.forEach(r => {
            if (r.title) titles.add(r.title);
        });
        console.log("Deleted chunks that belonged to titles:");
        console.log(Array.from(titles));
    } catch (e) {
        console.error("Error:", e);
    } finally {
        pool.end();
    }
}
clean();
