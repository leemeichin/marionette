# Session 3 notes (as given)

> We need to migrate our main database from MySQL to Postgres. Start with a spike on pglogical-style replication tooling — two attempts at most, it's fiddly. If replication can't be made reliable we fall back to a dual-write approach at the application layer, which is slower but safer. Either way our DBA Priya has to sign off on the cutover plan before we touch production. Do the cutover during a maintenance window, watch error rates for 48 hours, and if things spike we roll back to MySQL and regroup. Once it's stable for a week we decommission the old primary.
