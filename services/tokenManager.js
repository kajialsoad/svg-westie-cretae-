const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const dbPath = path.join(__dirname, '..', 'token-db.json');

// Initialize DB if not exists
if (!fs.existsSync(dbPath)) {
  fs.writeFileSync(dbPath, JSON.stringify({ tokens: [] }, null, 2));
}

function getTokens() {
  try {
    const data = fs.readFileSync(dbPath, 'utf8');
    const tokens = JSON.parse(data).tokens;
    let modified = false;
    const now = new Date();
    tokens.forEach(token => {
      if (token.status === 'active' && token.expiresAt && new Date(token.expiresAt) < now) {
        token.status = 'disabled';
        modified = true;
      }
    });
    if (modified) {
      saveTokens(tokens);
    }
    return tokens;
  } catch (error) {
    return [];
  }
}

function saveTokens(tokens) {
  fs.writeFileSync(dbPath, JSON.stringify({ tokens }, null, 2));
}

function generateToken(expiryDays = 30) {
  const tokens = getTokens();
  const newToken = {
    id: uuidv4(),
    token: `ASPRO-${uuidv4().substring(0, 8).toUpperCase()}`,
    status: 'active', // active, disabled, revoked
    createdAt: new Date().toISOString(),
    expiresAt: expiryDays ? new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000).toISOString() : null
  };
  tokens.push(newToken);
  saveTokens(tokens);
  return newToken;
}

function verifyToken(tokenStr) {
  if (!tokenStr) return false;
  
  const tokens = getTokens();
  const token = tokens.find(t => t.token === tokenStr);
  
  if (!token) return false;
  if (token.status !== 'active') return false;
  
  if (token.expiresAt && new Date(token.expiresAt) < new Date()) {
    token.status = 'disabled'; // Auto disable if expired
    saveTokens(tokens);
    return false;
  }
  
  return true;
}

function updateTokenStatus(tokenId, newStatus) {
  const tokens = getTokens();
  const tokenIndex = tokens.findIndex(t => t.id === tokenId);
  if (tokenIndex > -1) {
    tokens[tokenIndex].status = newStatus;
    saveTokens(tokens);
    return tokens[tokenIndex];
  }
  return null;
}

function setTokenExpiry(tokenId, days) {
  const tokens = getTokens();
  const tokenIndex = tokens.findIndex(t => t.id === tokenId);
  if (tokenIndex > -1) {
    const newExpiry = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    tokens[tokenIndex].expiresAt = newExpiry;
    // If it was disabled due to expiry, re-enable it if the new date is in the future
    if (tokens[tokenIndex].status === 'disabled' && new Date(newExpiry) > new Date()) {
      tokens[tokenIndex].status = 'active';
    }
    saveTokens(tokens);
    return tokens[tokenIndex];
  }
  return null;
}

function deleteToken(tokenId) {
  let tokens = getTokens();
  tokens = tokens.filter(t => t.id !== tokenId);
  saveTokens(tokens);
  return true;
}

module.exports = {
  getTokens,
  generateToken,
  verifyToken,
  updateTokenStatus,
  setTokenExpiry,
  deleteToken
};
