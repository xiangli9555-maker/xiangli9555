'use strict';

function deletePrecondition(row, body, nameField) {
  const expectedRevision = Number(body && body.expected_revision);
  const confirmedName = String(body && body.confirm_name || '').trim();
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    return { status: 428, error: 'revision_required' };
  }
  if (!confirmedName) {
    return { status: 428, error: 'delete_confirmation_required' };
  }
  if (confirmedName !== String(row && row[nameField] || '').trim()) {
    return { status: 409, error: 'delete_confirmation_mismatch' };
  }
  if (expectedRevision !== Number(row && row.revision || 1)) {
    return { status: 409, error: 'revision_conflict', current_revision: Number(row && row.revision || 1) };
  }
  return null;
}

module.exports = { deletePrecondition };
