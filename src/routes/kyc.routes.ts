import { Hono } from 'hono';

const kycRoutes = new Hono();

/**
 * GET /kyc/status
 * Get KYC status
 */
kycRoutes.get('/status', async (c) => {
    // TODO: Implement with auth middleware
    return c.json({
        success: true,
        data: {
            level: 'NONE',
            status: 'NOT_STARTED',
            documents: [],
            creditScore: null,
            creditTier: null,
        },
    });
});

/**
 * POST /kyc/documents
 * Upload a KYC document
 */
kycRoutes.post('/documents', async (c) => {
    // TODO: Implement document upload with file handling
    return c.json({
        success: true,
        message: 'Document uploaded successfully',
        data: {
            id: 'document_id',
            type: 'GOVERNMENT_ID',
            status: 'PENDING',
        },
    }, 201);
});

/**
 * GET /kyc/documents
 * List uploaded documents
 */
kycRoutes.get('/documents', async (c) => {
    // TODO: Implement document listing
    return c.json({
        success: true,
        data: [],
    });
});

/**
 * DELETE /kyc/documents/:id
 * Delete a document
 */
kycRoutes.delete('/documents/:id', async (c) => {
    const id = c.req.param('id');

    // TODO: Implement document deletion
    return c.json({
        success: true,
        message: 'Document deleted',
    });
});

/**
 * POST /kyc/submit
 * Submit documents for verification
 */
kycRoutes.post('/submit', async (c) => {
    // TODO: Implement KYC submission to AI service
    return c.json({
        success: true,
        message: 'KYC submitted for verification',
        data: {
            status: 'PENDING_KYC',
            submittedAt: new Date().toISOString(),
        },
    });
});

export { kycRoutes };
