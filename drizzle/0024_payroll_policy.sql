INSERT OR IGNORE INTO `system_state` (`key`, `value`, `updated_at`)
VALUES (
  'global_payroll_policy_v1',
  '{"schemaVersion":1,"managerMonthlySalaryVnd":3000000,"managerKpiRateBasisPoints":null,"employeeKpiTiers":[{"minimumProfitPerHour":30000,"rateBasisPoints":700},{"minimumProfitPerHour":15000,"rateBasisPoints":500},{"minimumProfitPerHour":7000,"rateBasisPoints":300}],"version":1,"updatedBy":null,"mutationToken":null}',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
