/**
 * Farm Clicker — Broadcast Worker
 * Runs every minute
 */

import pg from "pg";

const { Pool } = pg;

const CONFIG = {
  BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  DATABASE_URL: process.env.DATABASE_URL || "",
  MESSAGE_DELAY_MS: 100,
};


if (!CONFIG.BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

if (!CONFIG.DATABASE_URL) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}


const pool = new Pool({
  connectionString: CONFIG.DATABASE_URL,
});


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}



async function sendMessage(telegramId, text) {

  try {

    const response = await fetch(
      `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers:{
          "Content-Type":"application/json"
        },
        body: JSON.stringify({
          chat_id: telegramId,
          text,
          parse_mode:"HTML"
        })
      }
    );


    const result = await response.json();


    if (!result.ok) {

      return {
        success:false,
        error:result.description || "Telegram error"
      };

    }


    return {
      success:true,
      error:null
    };


  } catch(error){

    return {
      success:false,
      error:error.message
    };

  }

}




async function processBroadcast(){


  const {rows} = await pool.query(`
    SELECT *
    FROM broadcasts
    WHERE status='pending'
    ORDER BY id ASC
    LIMIT 1
  `);



  if(rows.length === 0){

    console.log("No broadcast");
    return;

  }



  const broadcast = rows[0];



  await pool.query(`
    UPDATE broadcasts
    SET status='running',
        started_at=NOW()
    WHERE id=$1
  `,
  [
    broadcast.id
  ]);




  const {rows:users} = await pool.query(`
    SELECT id, telegram_id
    FROM users
    WHERE telegram_id IS NOT NULL
    AND is_banned=false
  `);



  await pool.query(`
    UPDATE broadcasts
    SET total_users=$1
    WHERE id=$2
  `,
  [
    users.length,
    broadcast.id
  ]);




  let success = 0;
  let failed = 0;




  for(const user of users){



    const already = await pool.query(`
      SELECT id
      FROM broadcast_sent
      WHERE broadcast_id=$1
      AND user_id=$2
      LIMIT 1
    `,
    [
      broadcast.id,
      user.id
    ]);



    if(already.rows.length){

      continue;

    }



    const result = await sendMessage(
      user.telegram_id,
      broadcast.message
    );




    await pool.query(`
      INSERT INTO broadcast_sent
      (
        broadcast_id,
        user_id,
        status,
        error
      )
      VALUES($1,$2,$3,$4)
    `,
    [
      broadcast.id,
      user.id,
      result.success ? "sent" : "failed",
      result.error
    ]);





    if(result.success){

      success++;

    }else{

      failed++;

    }




    await pool.query(`
      UPDATE broadcasts
      SET success_count=$1,
          failed_count=$2
      WHERE id=$3
    `,
    [
      success,
      failed,
      broadcast.id
    ]);




    await sleep(CONFIG.MESSAGE_DELAY_MS);

  }





  await pool.query(`
    UPDATE broadcasts
    SET status='completed',
        finished_at=NOW()
    WHERE id=$1
  `,
  [
    broadcast.id
  ]);



  console.log(
    `Broadcast ${broadcast.id} completed`,
    {
      success,
      failed
    }
  );


}





async function main(){

  try{

    await processBroadcast();

  }
  catch(error){

    console.error(
      "Worker error:",
      error
    );

  }
  finally{

    await pool.end();

  }

}



main();
