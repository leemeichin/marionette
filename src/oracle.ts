/**
 * Public oracle/query compatibility surface over the production rule engine.
 */

import {
  ruleOracleReport,
  ruleQuery,
  type RuleBindings,
  type RuleOracleFinding,
  type RuleOracleReport,
} from './rule-engine.ts';

export type OracleFinding = RuleOracleFinding;
export type OracleReport = RuleOracleReport;

export const oracleReport = ruleOracleReport;

export async function oracleQuery(
  facts: string,
  goal: string,
  limit = 200,
): Promise<RuleBindings[]> {
  return ruleQuery(facts, goal, limit);
}
