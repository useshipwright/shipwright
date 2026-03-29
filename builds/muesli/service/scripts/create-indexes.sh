#!/usr/bin/env bash
# Create Firestore composite indexes for Muesli.
# Generated from analysis of src/adapters/firestore.ts queries.
#
# Usage:
#   bash scripts/create-indexes.sh [PROJECT_ID]
#
# Indexes are created async. Monitor with:
#   gcloud firestore indexes composite list --project=PROJECT_ID
set -euo pipefail

PROJECT="${1:-your-project-id}"
echo "Creating Firestore indexes for project: $PROJECT"
echo "This runs async -- each index takes 2-10 minutes to build."
echo ""

# ── meetings ─────────────────────────────────────────────────────────

echo "=== meetings ==="

# listMeetings: userId + createdAt desc (base)
gcloud firestore indexes composite create \
  --collection-group=meetings \
  --field-config field-path=userId,order=ascending \
  --field-config field-path=createdAt,order=descending \
  --project="$PROJECT" --quiet 2>/dev/null && echo "  OK meetings: userId+createdAt(desc)" || echo "  EXISTS meetings: userId+createdAt(desc)"

# listMeetings: userId + status + createdAt desc
gcloud firestore indexes composite create \
  --collection-group=meetings \
  --field-config field-path=userId,order=ascending \
  --field-config field-path=status,order=ascending \
  --field-config field-path=createdAt,order=descending \
  --project="$PROJECT" --quiet 2>/dev/null && echo "  OK meetings: userId+status+createdAt(desc)" || echo "  EXISTS meetings: userId+status+createdAt(desc)"

# listMeetings: userId + isStarred + createdAt desc
gcloud firestore indexes composite create \
  --collection-group=meetings \
  --field-config field-path=userId,order=ascending \
  --field-config field-path=isStarred,order=ascending \
  --field-config field-path=createdAt,order=descending \
  --project="$PROJECT" --quiet 2>/dev/null && echo "  OK meetings: userId+isStarred+createdAt(desc)" || echo "  EXISTS"

# listMeetings: userId + tags(array-contains) + createdAt desc
gcloud firestore indexes composite create \
  --collection-group=meetings \
  --field-config field-path=userId,order=ascending \
  --field-config field-path=tags,array-config=contains \
  --field-config field-path=createdAt,order=descending \
  --project="$PROJECT" --quiet 2>/dev/null && echo "  OK meetings: userId+tags+createdAt(desc)" || echo "  EXISTS"

# searchMeetings: userId + searchTokens(array-contains-any) + createdAt desc
gcloud firestore indexes composite create \
  --collection-group=meetings \
  --field-config field-path=userId,order=ascending \
  --field-config field-path=searchTokens,array-config=contains \
  --field-config field-path=createdAt,order=descending \
  --project="$PROJECT" --quiet 2>/dev/null && echo "  OK meetings: userId+searchTokens+createdAt(desc)" || echo "  EXISTS"

# ── actions ──────────────────────────────────────────────────────────

echo "=== actions ==="

# listActions: userId + createdAt desc
gcloud firestore indexes composite create \
  --collection-group=actions \
  --field-config field-path=userId,order=ascending \
  --field-config field-path=createdAt,order=descending \
  --project="$PROJECT" --quiet 2>/dev/null && echo "  OK actions: userId+createdAt(desc)" || echo "  EXISTS"

# listActions: userId + status + createdAt desc
gcloud firestore indexes composite create \
  --collection-group=actions \
  --field-config field-path=userId,order=ascending \
  --field-config field-path=status,order=ascending \
  --field-config field-path=createdAt,order=descending \
  --project="$PROJECT" --quiet 2>/dev/null && echo "  OK actions: userId+status+createdAt(desc)" || echo "  EXISTS"

# listActions: userId + meetingId + createdAt desc
gcloud firestore indexes composite create \
  --collection-group=actions \
  --field-config field-path=userId,order=ascending \
  --field-config field-path=meetingId,order=ascending \
  --field-config field-path=createdAt,order=descending \
  --project="$PROJECT" --quiet 2>/dev/null && echo "  OK actions: userId+meetingId+createdAt(desc)" || echo "  EXISTS"

# searchActions: userId + searchTokens + createdAt desc
gcloud firestore indexes composite create \
  --collection-group=actions \
  --field-config field-path=userId,order=ascending \
  --field-config field-path=searchTokens,array-config=contains \
  --field-config field-path=createdAt,order=descending \
  --project="$PROJECT" --quiet 2>/dev/null && echo "  OK actions: userId+searchTokens+createdAt(desc)" || echo "  EXISTS"

# ── shares ───────────────────────────────────────────────────────────

echo "=== shares ==="

gcloud firestore indexes composite create \
  --collection-group=shares \
  --field-config field-path=meetingId,order=ascending \
  --field-config field-path=userId,order=ascending \
  --project="$PROJECT" --quiet 2>/dev/null && echo "  OK shares: meetingId+userId" || echo "  EXISTS"

# ── embeddings ───────────────────────────────────────────────────────

echo "=== embeddings ==="

gcloud firestore indexes composite create \
  --collection-group=embeddings \
  --field-config field-path=meetingId,order=ascending \
  --field-config field-path=userId,order=ascending \
  --project="$PROJECT" --quiet 2>/dev/null && echo "  OK embeddings: meetingId+userId" || echo "  EXISTS"

echo ""
echo "Done. Indexes building async (2-10 min each)."
echo "Monitor: gcloud firestore indexes composite list --project=$PROJECT"
