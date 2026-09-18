function createLoginStats(pool) {
  let ensurePromise;

  function ensure() {
    if (!ensurePromise) {
      ensurePromise = Promise.resolve().then(() => pool.query(`
        CREATE TABLE IF NOT EXISTS vomi_login_stats (
          account VARCHAR(64) NOT NULL PRIMARY KEY,
          name VARCHAR(128) NOT NULL,
          group_name VARCHAR(16) NOT NULL,
          first_seen_at DATETIME(3) NOT NULL,
          last_seen_at DATETIME(3) NOT NULL,
          first_login_at DATETIME(3) NULL,
          last_login_at DATETIME(3) NULL,
          login_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
          visit_count BIGINT UNSIGNED NOT NULL DEFAULT 0
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `)).catch(error => {
        ensurePromise = undefined;
        throw error;
      });
    }
    return ensurePromise;
  }

  async function record(identity, kind) {
    await ensure();
    const login = kind === 'login' ? 1 : 0;
    const visit = kind === 'resume' ? 1 : 0;
    await pool.query(`
      INSERT INTO vomi_login_stats (
        account, name, group_name, first_seen_at, last_seen_at,
        first_login_at, last_login_at, login_count, visit_count
      ) VALUES (
        ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3),
        IF(? = 1, UTC_TIMESTAMP(3), NULL),
        IF(? = 1, UTC_TIMESTAMP(3), NULL), ?, ?
      ) ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        group_name = VALUES(group_name),
        last_seen_at = VALUES(last_seen_at),
        first_login_at = COALESCE(first_login_at, VALUES(first_login_at)),
        last_login_at = COALESCE(VALUES(last_login_at), last_login_at),
        login_count = login_count + VALUES(login_count),
        visit_count = visit_count + VALUES(visit_count)
    `, [identity.account, identity.name, identity.group, login, login, login, visit]);
  }

  async function report(users) {
    await ensure();
    const [rows] = await pool.query(`
      SELECT account, name, group_name,
        DATE_FORMAT(first_seen_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS first_seen_at,
        DATE_FORMAT(last_seen_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS last_seen_at,
        DATE_FORMAT(first_login_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS first_login_at,
        DATE_FORMAT(last_login_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS last_login_at,
        login_count, visit_count
      FROM vomi_login_stats
      ORDER BY account
    `);
    const byAccount = new Map(rows.map(row => [row.account, row]));
    const rosterAccounts = new Set(users.map(user => user.account));

    function summarize(identity, row, inRoster) {
      const loginCount = Number(row?.login_count ?? 0);
      const visitCount = Number(row?.visit_count ?? 0);
      return {
        account: identity.account,
        name: identity.name,
        group: identity.group,
        inRoster,
        hasLoggedIn: loginCount > 0,
        hasVisited: Boolean(row?.first_seen_at),
        firstSeenAt: row?.first_seen_at ?? null,
        lastSeenAt: row?.last_seen_at ?? null,
        firstLoginAt: row?.first_login_at ?? null,
        lastLoginAt: row?.last_login_at ?? null,
        loginCount,
        visitCount,
      };
    }

    const resultUsers = users.map(user => summarize(user, byAccount.get(user.account), true));
    for (const row of rows) {
      if (!rosterAccounts.has(row.account)) {
        resultUsers.push(summarize({ account: row.account, name: row.name, group: row.group_name }, row, false));
      }
    }
    return {
      ok: true,
      users: resultUsers,
      summary: {
        rosterUsers: users.length,
        observedUsers: rows.length,
        loggedInUsers: rows.filter(row => Number(row.login_count) > 0).length,
        totalLogins: rows.reduce((sum, row) => sum + Number(row.login_count), 0),
        totalVisits: rows.reduce((sum, row) => sum + Number(row.visit_count), 0),
      },
      historyNote: '仅统计功能上线后的记录；旧登录凭据首次访问只记访问，不补造历史登录。',
    };
  }

  return { ensure, record, report };
}

module.exports = { createLoginStats };
