var express = require('express');
var router = express.Router();

//controllers
let {
    pingPong,
    allCustomers,
    addCustomer,
    deleteCustomer
} = require("../controllers/customersController");

/* GET ping (for testing) */
router.get('/ping', pingPong);

router.get('/test1', test1);

/* GET /api/customers/all (list all customers) */
router.get("/all", allCustomers);

/* POST /api/customers/add (add a customer) */
router.post("/add", addCustomer);

/* DELETE /api/customers/:id (delete a customer) */
router.delete("/:id", deleteCustomer);


module.exports = router;
