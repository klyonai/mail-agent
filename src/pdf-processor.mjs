import {randomUUID} from 'node:crypto';
import {PdfError,createPdfRequest} from './pdf-contract.mjs';
import {runPdfWorker} from './pdf-worker-supervisor.mjs';

/** No default native launcher: deployments must provide a separately qualified adapter. */
export function createPdfProcessor({processorDigest,startWorker,clock=Date.now,idFactory=randomUUID,
  setTimer=setTimeout,clearTimer=clearTimeout}={}) {
  if(typeof processorDigest!=='string'||!/^[a-f0-9]{64}$/.test(processorDigest)
    ||typeof clock!=='function'||typeof idFactory!=='function'||typeof setTimer!=='function'
    ||typeof clearTimer!=='function')throw new PdfError('PDF_INVALID_INPUT');
  return {async render({bytes,expiresAt,limits,signal}={}) {
    if(signal?.aborted)throw new PdfError('PDF_CANCELLED');
    let request;
    try {request=createPdfRequest({bytes,expiresAt,limits,processorDigest,jobId:idFactory()},{now:clock()});}
    catch(error) {if(error instanceof PdfError)throw error;throw new PdfError('PDF_PROCESSOR_FAILED');}
    return runPdfWorker(request,{startWorker,clock,signal,setTimer,clearTimer});
  }};
}
