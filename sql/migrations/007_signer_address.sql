/*
  Migration 007 - address of the signer's location
  ------------------------------------------------
  Run in SSMS against your database, or:  npm run db:migrate
  Safe to re-run.

  - ContractSigners.LocationAddress: street address looked up from the GPS location captured while signing
    (see src/geocode.js). Also inside LocationJson as "address".
*/

IF COL_LENGTH(N'eSign.ContractSigners', N'LocationAddress') IS NULL
  ALTER TABLE eSign.ContractSigners ADD LocationAddress NVARCHAR(500) NULL;
GO
