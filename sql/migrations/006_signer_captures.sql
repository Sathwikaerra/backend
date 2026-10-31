/*
  Migration 006 - location and live photo captured while signing
  --------------------------------------------------------------
  Run in SSMS against your database, or:  npm run db:migrate
  Safe to re-run.

  - ContractSigners.Captures: what the workflow asks this signer to capture ('location', 'photo', comma separated).
  - ContractSigners.LocationJson: { lat, lng, accuracy, capturedAt } from the signer's device (GPS / browser location).
  - ContractSigners.PhotoImage: live photo taken with the camera while signing (JPEG data URL).
*/

IF COL_LENGTH(N'eSign.ContractSigners', N'Captures') IS NULL
  ALTER TABLE eSign.ContractSigners ADD Captures NVARCHAR(100) NULL;
GO
IF COL_LENGTH(N'eSign.ContractSigners', N'LocationJson') IS NULL
  ALTER TABLE eSign.ContractSigners ADD LocationJson NVARCHAR(1000) NULL;
GO
IF COL_LENGTH(N'eSign.ContractSigners', N'PhotoImage') IS NULL
  ALTER TABLE eSign.ContractSigners ADD PhotoImage NVARCHAR(MAX) NULL;
GO
