import { start } from "../machine/order.machine";

const order = start();
console.log(order.state, order.send("pay"), order.state);
