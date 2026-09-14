/**
 * Page entry point: build the view, hand it a controller, and connect the two.
 */

import { PreviewController } from './controller.js';
import { createView } from './view.js';

const view = createView();
const controller = new PreviewController({ view });
view.bind(controller);
