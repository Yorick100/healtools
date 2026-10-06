const db=require('../src/db');
db.migrate().then(()=>{console.log('HEALTOOLS schema 0.4.3 migration complete');process.exit(0);}).catch(e=>{console.error(e);process.exit(1);});
