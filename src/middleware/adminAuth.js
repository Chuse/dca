/**
 * Admin Authentication Middleware
 * Protege los endpoints /api/admin/* con API Key
 */

function adminAuth(req, res, next) {
  const adminKey = process.env.ADMIN_API_KEY;
  
  // Si no hay API key configurada, denegar todo acceso admin
  if (!adminKey) {
    console.warn('[AUTH] ADMIN_API_KEY no configurada - acceso admin denegado');
    return res.status(500).json({ 
      error: 'Administración no configurada',
      message: 'Contacte al administrador del sistema'
    });
  }
  
  // Obtener la key del header
  const providedKey = req.headers['x-admin-key'];
  
  if (!providedKey) {
    return res.status(401).json({ 
      error: 'No autorizado',
      message: 'Se requiere X-Admin-Key header'
    });
  }
  
  if (providedKey !== adminKey) {
    console.warn(`[AUTH] Intento de acceso admin fallido desde ${req.ip}`);
    return res.status(401).json({ 
      error: 'No autorizado',
      message: 'API Key inválida'
    });
  }
  
  // Key válida, continuar
  next();
}

module.exports = adminAuth;
