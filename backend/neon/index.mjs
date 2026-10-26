import {createBackend} from './core.mjs';
import {createService} from './service.mjs';
import {createQuoteHandler} from 'ticketline:quotes';
export default createBackend({env:process.env,service:createService(process.env.DATABASE_URL),quoteFactory:createQuoteHandler});
