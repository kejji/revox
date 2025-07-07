const { RDSDataClient, ExecuteStatementCommand } = require("@aws-sdk/client-rds-data");
const client = new RDSDataClient({ region: process.env.AWS_REGION });

const SQL_STATEMENTS = [ /* tes DDL */ ];

exports.handler = async () => {
  const { DB_CLUSTER_ARN, DB_SECRET_ARN } = process.env;
  for (const sql of SQL_STATEMENTS) {
    await client.send(new ExecuteStatementCommand({
      resourceArn: DB_CLUSTER_ARN,
      secretArn:  DB_SECRET_ARN,
      sql,
      database: "revox"
    }));
  }
  return { status: "migrations applied" };
};

