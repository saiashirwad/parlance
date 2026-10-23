import { start } from "../machine/order.machine";

const order = start();
const checkout = order.send({ type: "pay", amount: 25 });
const paid = order.send({ type: "pay", amount: 50 });
const last = order.lastEvent;
console.log(order.state, checkout, paid, last?.type, last?.type === "pay" ? last.amount : "none");
