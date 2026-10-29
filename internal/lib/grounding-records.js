import express from 'express';
import { asyncRoute } from './errors.js';

export function createGroundingRouter(library) {
    const router = express.Router();
    router.get('/grounding/sources', (request,response) => response.json(library.listSources(request.user,request.query)));
    router.get('/grounding/sources/:type/:id', (request,response) => response.json({ source:library.source({user:request.user,type:request.params.type,id:request.params.id}) }));
    router.post('/grounding/sources/:type/:id/confirm', (request,response) => response.json({ source:library.confirmSource(request.user,request.params.type,request.params.id,request.body) }));
    router.post('/grounding/sources/:type/:id/revoke', (request,response) => response.json({ source:library.revokeSource(request.user,request.params.type,request.params.id,request.body) }));
    router.post('/grounding/sources/:type/:id/suggest-facts', asyncRoute(async (request,response) => {
        const controller = new AbortController();
        const aborted = () => controller.abort();
        const closed = () => { if (!response.writableEnded) controller.abort(); };
        request.once('aborted', aborted); response.once('close', closed);
        try {
            response.json(await library.suggestFacts(request.user,request.params.type,request.params.id,request.body,
                { sessionId:request.session?.id, signal:controller.signal }));
        } finally { request.removeListener('aborted',aborted); response.removeListener('close',closed); }
    }));
    router.get('/grounding/facts', (request,response) => response.json(library.listFacts(request.user,request.query)));
    router.get('/grounding/facts/:id', (request,response) => response.json({ fact:library.factView(library.getFact(request.user,request.params.id),request.user) }));
    router.post('/grounding/facts', (request,response) => response.status(201).json({ fact:library.createFact(request.user,request.body) }));
    router.patch('/grounding/facts/:id', (request,response) => response.json({ fact:library.updateFact(request.user,request.params.id,request.body) }));
    router.post('/grounding/facts/:id/confirm', (request,response) => response.json({ fact:library.confirmFact(request.user,request.params.id,request.body) }));
    router.post('/grounding/facts/:id/revoke', (request,response) => response.json({ fact:library.revokeFact(request.user,request.params.id,request.body) }));
    router.delete('/grounding/facts/:id', (request,response) => { library.revokeFact(request.user,request.params.id,request.body || {},true); response.json({ok:true}); });
    return router;
}
